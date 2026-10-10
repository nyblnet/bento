// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Debounced write-back to the REAL file — the half of auto-save that touches
// the thing the user thinks of as their work.
//
// WHAT WAS BROKEN. dash had the backstop and not the save. Every 2.5s of
// editing wrote `putRecovery(store.doc)` into IndexedDB (main.ts) and, since
// recovery.ts landed, that snapshot is offered back on the next open. But the
// FILE was untouched between manual ⌘S presses, so everything since the last
// one depended on a browser database surviving — a database the user cannot
// see, cannot copy, cannot email, and which Safari clears on its own schedule.
// slides has rewritten the open file silently since v0.9.8. dash did not, and a
// spreadsheet is the document type where it matters most: people type into a
// grid for an hour without once thinking about saving, because every other
// spreadsheet they have ever used saved itself.
//
// THE TWO CHANNELS ARE NOT THE SAME CHANNEL, and conflating them is how the
// encryption rule gets applied to the wrong one.
//
//   · IndexedDB snapshot — writes the document as PLAIN JSON into browser
//     storage. For an encrypted workbook that is precisely what the password
//     exists to prevent, so main.ts and about.ts both refuse it. Correct.
//   · File write-back — writes the file the workbook already lives in, through
//     `serializeAuto`, which is the encryption-aware path (kernel/src/save.ts):
//     a password-protected workbook is re-encrypted with the password held in
//     memory and the bytes on disk stay ciphertext. Nothing new reaches the
//     disk that a manual ⌘S would not have written to the same path a moment
//     later. So write-back is ALLOWED while encrypted, and refusing it would
//     leave the users who care most about their data as the only ones with no
//     automatic save at all.
//
// WHEN IT FAILS IT SAYS SO. slides swallows the write error (`catch { }`) and
// leans on the snapshot; that is defensible there and not here, because the
// whole point of this feature is that the author stops thinking about saving.
// A silent failed write is worse than no write-back: it converts "I should
// press ⌘S" into "it saves itself" and then quietly stops being true. A
// revoked permission, a deleted file, a full disk, a removed USB stick and a
// file open in another tab all arrive as a rejected promise here, and every one
// of them means the file on disk is now STALE while the screen looks calm.
// `nextNotice` below is the honesty policy, stated as a pure function so it can
// be proved rather than eyeballed.
//
// WHAT IT REFUSES TO WRITE, and why each one is a data-loss bug rather than
// tidiness (`planWriteBack`):
//
//   1. READ-ONLY. A frozen workbook (unknown policy, future format version) is
//      opened read-only *so that nothing is lost*; rewriting it is the exact
//      thing that mode exists to prevent. `store.readOnly` covers the boot path
//      and `doc.readonly` is checked as well — `swapWorkbook` (recovery.ts)
//      tests the CURRENT store's flag, not the incoming document's, so a
//      read-only workbook dropped onto a writable window lands with the store
//      still unlocked. That is a live hazard for ⌘S too; here it is at least
//      not compounded by an automatic write.
//   2. A TEMPLATE. `adoptOpenedDoc` (saveui.ts) makes every open of a template
//      a fresh workbook — but it runs at BOOT only, and `dropopen.ts` adopts a
//      writable handle to whatever was dropped. Drop a template onto dash and
//      the file on disk is a template while the document in memory is the
//      workbook you have started in it; write-back would overwrite the template
//      with one person's data, silently, on a file they meant to reuse. A
//      template is a source, not a destination.
//   3. NO HANDLE. Safari, Firefox and every browser on iOS have no File System
//      Access API, so there is no file to write to. Nothing is claimed; the
//      IndexedDB snapshot stays the only backstop and main.ts already tells the
//      author when even that is unavailable.
//   4. UNCHANGED. Compared by CONTENT (`contentKey`, recovery.ts) against what
//      was last written, not by a dirty flag. `doc` events fire for reasons
//      that do not change the document, and a workbook can be tens of MB —
//      re-serializing and rewriting the whole shell to store identical bytes
//      is a visible stall on the grid for no gain. Sharing recovery.ts's key
//      also means write-back and the recovery banner can never disagree about
//      what "changed" means.

import { hasFileHandle, writeUpdatedFile, serializeAuto } from '../../kernel/src/save.ts'
import { contentKey } from './recovery.ts'
import type { DashDoc } from './model.ts'

// --- the decision ------------------------------------------------------------

/** Why a cycle wrote nothing. Named, not boolean, so a refusal can be told
 *  apart from "there was nothing to do" in the rig and in a bug report. */
export type SkipReason = 'read-only' | 'template' | 'no-handle' | 'unchanged'

export type Outcome =
  | { kind: 'wrote'; at: number }
  | { kind: 'skipped'; why: SkipReason }
  /** `why` is the message shown to the author, so it is the error's text, not a code. */
  | { kind: 'failed'; why: string }

export interface PlanInput {
  doc: DashDoc
  /** the store refuses commits — frozen document, or a `readonly` copy */
  readOnly: boolean
  /** a writable File System Access handle is held — `hasFileHandle()` */
  hasHandle: boolean
  /** `contentKey` of the last bytes this session actually got onto disk, or null */
  lastWritten: string | null
}

export type Plan = { write: true; key: string } | { write: false; why: SkipReason }

/**
 * The whole yes/no, with no DOM, no IndexedDB and no file system in it.
 *
 * Order matters: the two REFUSALS come before the two "nothing to do" answers,
 * so a read-only or template workbook reports why it will never be written
 * rather than the incidental fact that this browser could not have written it
 * anyway. A caller that wants to explain the feature's absence needs the
 * permanent reason, not the first one that happened to match.
 */
export function planWriteBack(input: PlanInput): Plan {
  if (input.readOnly || input.doc.readonly) return { write: false, why: 'read-only' }
  if (input.doc.template) return { write: false, why: 'template' }
  if (!input.hasHandle) return { write: false, why: 'no-handle' }
  const key = contentKey(input.doc)
  if (input.lastWritten !== null && key === input.lastWritten) return { write: false, why: 'unchanged' }
  return { write: true, key }
}

// --- the honesty policy -------------------------------------------------------

/** What the author is told, if anything. `null` is the common case: a
 *  successful cycle in a run of successful cycles says nothing at all. */
export type Notice =
  | { say: 'saved' }
  /** the first write after a run of failures — the file is current again, and
   *  the author has been staring at a warning that is now wrong */
  | { say: 'recovered' }
  | { say: 'failed'; why: string }

export interface NoticeState {
  /** the last cycle that tried to write, failed */
  failing: boolean
  /** its message — a DIFFERENT failure is news even while already failing */
  lastError: string
}

export const freshNotice = (): NoticeState => ({ failing: false, lastError: '' })

/**
 * How loud to be about an outcome.
 *
 * Two failure modes to steer between, and the second is the one that bites.
 * Say too much and a toast fires every 2.5s while someone types, which is
 * unusable and gets the whole feature switched off in the reader's head. Say
 * too little — which is what "warn once per session" would be — and a failure
 * that STARTS mid-session after ten successful minutes never reaches the person
 * whose file has just stopped being written.
 *
 * So: transitions are announced, steady states are not. Entering failure
 * speaks; a different error while already failing speaks (a full disk and a
 * revoked permission want different actions from the author); the same error
 * repeating does not; and LEAVING failure speaks, because a warning that is no
 * longer true is its own kind of lie and the author cannot know it lapsed.
 *
 * A successful write in the normal run reports 'saved', which is deliberately
 * NOT a toast at the call site — it is the momentary tag beside the Save
 * button. The distinction is the point: confirmation should be visible if you
 * look and ignorable if you don't; a failure has to interrupt.
 */
export function nextNotice(prev: NoticeState, out: Outcome): { state: NoticeState; notice: Notice | null } {
  if (out.kind === 'wrote') {
    const notice: Notice = prev.failing ? { say: 'recovered' } : { say: 'saved' }
    return { state: freshNotice(), notice }
  }
  if (out.kind === 'failed') {
    const news = !prev.failing || prev.lastError !== out.why
    return { state: { failing: true, lastError: out.why }, notice: news ? { say: 'failed', why: out.why } : null }
  }
  return { state: prev, notice: null }
}

// --- the runner ---------------------------------------------------------------

/**
 * Everything that touches the world, injectable — so the rig can drive a whole
 * write, a whole failure and a whole overlap without a browser, a file system
 * or a fake `window`.
 */
export interface WriteBackDeps {
  hasHandle: () => boolean
  /** encryption-aware; an encrypted workbook stays ciphertext on disk */
  serialize: (doc: DashDoc) => Promise<string>
  write: (html: string) => Promise<void>
  /** stamp live-collaboration state into the document just before it is
   *  serialized, so a copy edited offline can rejoin as a fork (PLATFORM §5) */
  stamp?: (doc: DashDoc) => void
}

export const liveDeps = (): WriteBackDeps => ({
  hasHandle: hasFileHandle,
  serialize: serializeAuto,
  write: writeUpdatedFile,
})

/**
 * The debounce-free core: one cycle, one answer. main.ts owns the timer,
 * because it already owns the 2.5s debounce the IndexedDB snapshot rides on and
 * two independent timers over the same edits would write the file twice.
 *
 * NEVER THROWS. This runs from a `setTimeout` with nobody awaiting it; a
 * rejection here is an unhandled promise rejection in a console the author is
 * not reading, which is exactly the invisibility this module exists to end.
 * The failure comes back as a value and the caller decides what to say.
 */
export class FileWriteBack {
  private lastWritten: string | null = null
  private notice = freshNotice()
  /** a cycle is mid-write; a 30MB workbook takes long enough for the next
   *  debounce to land on top of it, and two overlapping writables to the same
   *  handle is how a file ends up half one document and half another */
  private busy = false

  /** Spelled out rather than a parameter property: the rigs run under plain
   *  `node`, whose type-stripping refuses `constructor(private x)`. */
  private deps: WriteBackDeps
  constructor(deps: WriteBackDeps = liveDeps()) { this.deps = deps }

  /** True once this session has actually put bytes on disk — the caller's
   *  licence to say the file is current. */
  get everWrote(): boolean { return this.lastWritten !== null }

  get isFailing(): boolean { return this.notice.failing }

  /**
   * Run one cycle. Returns what happened AND what to tell the author, already
   * filtered by the transition policy above.
   */
  async run(doc: DashDoc, readOnly: boolean): Promise<{ outcome: Outcome; notice: Notice | null }> {
    if (this.busy) return { outcome: { kind: 'skipped', why: 'unchanged' }, notice: null }
    const plan = planWriteBack({ doc, readOnly, hasHandle: this.deps.hasHandle(), lastWritten: this.lastWritten })
    if (!plan.write) return { outcome: { kind: 'skipped', why: plan.why }, notice: null }
    this.busy = true
    let outcome: Outcome
    try {
      this.deps.stamp?.(doc)
      await this.deps.write(await this.deps.serialize(doc))
      // Recorded only AFTER the write resolves. Recording the intent would
      // make a failed cycle look "unchanged" to the next one, so a permanent
      // failure would be reported once and then silently skipped forever.
      this.lastWritten = plan.key
      outcome = { kind: 'wrote', at: Date.now() }
    } catch (err) {
      outcome = { kind: 'failed', why: err instanceof Error ? err.message : String(err) }
    } finally {
      this.busy = false
    }
    const n = nextNotice(this.notice, outcome)
    this.notice = n.state
    return { outcome, notice: n.notice }
  }

  /**
   * A manual ⌘S just wrote this document — adopt it as the baseline so the next
   * debounced cycle does not immediately rewrite identical bytes.
   *
   * Also clears a failure: ⌘S goes through the same handle, so a successful one
   * is proof the file is reachable again, and leaving the warning up after it
   * would tell the author their save did not land.
   */
  adopt(doc: DashDoc): void {
    this.lastWritten = contentKey(doc)
    this.notice = freshNotice()
  }
}
