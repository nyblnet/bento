// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Boot sequence for bento/spaces. Order matters: configure the app, then
// capture the pristine document BEFORE any DOM mutation — the captured copy is
// what gets re-serialized on save.

import './styles.css'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import { startTheme } from '../../kernel/src/theme.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, registerPreview,
  saveFile, parseEnvelope, canWriteInPlace, decryptEnvelope, setEncryptionPassword,
  writeUpdatedFileAs, suggestedFileName,
  isEncryptionActive,
} from '../../kernel/src/save.ts'
import { putRecovery, getRecovery, clearRecovery, pruneOld, addVersion } from '../../kernel/src/autosave.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { t, locale, applyDirection } from './i18n'
import { i18nApi } from '../../kernel/src/i18n.ts'
import { parseDoc, docContentKey, uid, newPage, type SpacesDoc, type ParseResult } from './model'
import {
  validateDoc, outlineDoc, statsDoc,
  planInsertBlocks, planUpdateBlock, planRemoveBlocks, planMoveBlock, planUpdatePage, planRemovePage,
  fieldsReport, issuesReport, planSetField, planNewIssue, commentsReport,
  plainTitle, badTitle,
  type Plan, type PlanError, type IssueQuery, type CommentQuery,
} from './agent'
import { starterDoc } from './starter'
import { todayISO, isISO, journalFor } from './journal'
import { textOf } from './sanitize'
import { evaluate, format, pageContext } from './calc'
import { buildSpacePreview } from './preview'
import { Store } from './store'
import { Editor } from './editor'
import { SyncSession } from './sync/session.ts'
import { isReaderCopy } from './share.ts'
import { downloadMarkdown, launchUpdateCheck } from './about'

configureApp({
  appId: 'bento-spaces',
  appName: 'bento/spaces',
  manifestUrl: 'https://bento.page/releases/spaces/manifest.json',
})

// Every save writes a still render of the home page into the shell, for the
// readers that run no script: macOS QuickLook, iOS Files, bento/home, and any
// preview pane that renders HTML without executing it. Without this the runtime
// never inflates, the splash is never removed, and a saved space shows a boot
// animation where its content should be. See preview.ts.
registerPreview((doc) => buildSpacePreview(doc as unknown as SpacesDoc))

capturePristine()

// The interface theme: AFTER capturePristine, before the first paint.
//
// AFTER, because capturePristine clones the LIVE document and every save
// re-serializes that clone — so `data-theme` and `color-scheme` must not be on
// <html> yet, or a reader's preference would ride inside every file they save
// and land on whoever they sent it to. Exactly the ordering applyDirection
// depends on for dir/lang, one line below, and for the same reason.
//
// BEFORE the paint, because applying it later paints the interface light and
// then flips it, which reads as a bug rather than as a preference. Nothing
// here lays anything out: it sets two attributes on the root element.
startTheme()
applyDirection()

const embedded = readEmbeddedDoc()

const envelope = embedded ? parseEnvelope(embedded) : null

if (envelope) {
  void passwordGate()
} else {
  const res = parseDoc(embedded ?? '')
  if (res.ok) {
    if (!res.doc.docId) res.doc.docId = uid('doc')
    boot(res.doc, res.repaired, res.frozen)
  } else if (res.err === 'empty') {
    // THE ONLY path to the starter. Anything else that failed to parse is
    // someone's data, and replacing it with an empty space would be a loss the
    // first ⌘S makes permanent.
    const doc = starterDoc()
    doc.docId = uid('doc')
    boot(doc, [], undefined)
  } else {
    refuse(res)
  }
}

/**
 * An encrypted space: ask, then boot.
 *
 * This MUST exist for as long as the About dialog can set a password —
 * otherwise encrypting a space locks its author out of it permanently, which
 * is the worst bug this app could have. The password is held in memory so
 * every later save stays encrypted.
 */
async function passwordGate(): Promise<void> {
  document.getElementById('bento-splash')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'sp-gate'
  const card = document.createElement('div')
  card.className = 'sp-gate-card'
  card.innerHTML = `<h1>${t('This space is locked')}</h1>` +
    `<p>${t('Enter the password to open it.')}</p>`
  const input = document.createElement('input')
  input.type = 'password'
  input.className = 'sp-find'
  input.autocomplete = 'current-password'
  const go = document.createElement('button')
  go.className = 'sp-btn sp-primary'
  go.textContent = t('Unlock')
  const err = document.createElement('p')
  err.className = 'sp-note'
  card.append(input, go, err)
  wrap.append(card)
  document.body.append(wrap)
  input.focus()

  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    go.disabled = true
    const json = await decryptEnvelope(envelope!, pass)
    go.disabled = false
    if (json === null) { err.textContent = t('Wrong password — try again'); input.select(); return }
    const res = parseDoc(json)
    if (!res.ok) { err.textContent = t('Unlocked, but the document inside could not be read.'); return }
    // held in memory so ⌘S and autosave keep writing encrypted
    setEncryptionPassword(pass)
    wrap.remove()
    if (!res.doc.docId) res.doc.docId = uid('doc')
    boot(res.doc, res.repaired, res.frozen)
  }
  go.addEventListener('click', () => { void tryUnlock() })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryUnlock() })
}

/**
 * A document we cannot read is NOT a reason to show an empty one.
 *
 * No editor, no autosave, and two ways out that do not require us to have
 * understood the file: keep the bytes exactly as they are, or take the JSON
 * somewhere else.
 */
function refuse(res: Extract<ParseResult, { ok: false }>): void {
  const detail = 'detail' in res ? res.detail : ''
  const what = res.err === 'format'
    ? t('This is not a bento/spaces document — {detail}.', { detail })
    : res.err === 'json'
      ? t('The document block is not valid JSON — {detail}.', { detail })
      : t('The document block is not shaped like a space — {detail}.', { detail })

  gate(t('This file could not be opened'), what, [
    [t('Save an untouched copy…'), () => {
      // the bytes as they are, NOT a re-serialization: we did not understand
      // this document, so we must not rewrite it
      const html = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      a.download = 'untouched-copy.bento.html'
      a.click()
    }],
    [t('Copy the document JSON'), () => { void navigator.clipboard?.writeText(embedded ?? '') }],
  ])

  const pre = document.createElement('pre')
  pre.className = 'sp-gate-raw'
  pre.textContent = (embedded ?? '').slice(0, 400)
  document.querySelector('.sp-gate-card')?.append(pre)
}

function gate(title: string, body: string, actions: Array<[string, () => void]>): void {
  document.getElementById('bento-splash')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'sp-gate'
  const card = document.createElement('div')
  card.className = 'sp-gate-card'
  const h = document.createElement('h1')
  h.textContent = title
  const p = document.createElement('p')
  p.textContent = body
  card.append(h, p)
  for (const [label, fn] of actions) {
    const b = document.createElement('button')
    b.className = 'sp-btn sp-primary'
    b.textContent = label
    b.addEventListener('click', fn)
    card.append(b)
  }
  wrap.append(card)
  document.body.append(wrap)
}

function boot(doc: SpacesDoc, repaired: string[], frozen?: 'policy' | 'version'): void {
  document.title = `${doc.title} — ${appConfig().appName}`
  document.getElementById('bento-splash')?.remove()

  const store = new Store(doc)
  // `doc.readonly` was declared in the format and read by NOTHING: a space
  // saved as a reading copy opened fully editable, so the one property the
  // sender chose was the one the file did not keep. It is not a security
  // boundary — anyone can edit the JSON — but a file that says it is a reading
  // copy must behave like one for the person who opens it.
  //
  // `frozen` is the other, unrelated reason to lock: this build does not
  // understand the file and must not rewrite it.
  //
  // `collab.role === 'reader'` is the THIRD, unrelated reason, and it is the
  // only one of the three that keeps receiving: a view-only copy follows the
  // live session and can never send to it. The lock here is a courtesy to the
  // person holding it — the ENFORCEMENT is the relay, which pins a verified
  // key per socket and drops op batches from a socket that presented none
  // (docs/collab-design.md, "Signed writes"). Remote ops still land, because
  // the kernel session applies them straight to `doc` rather than through
  // `commit()` — deliberately, so a colleague's edit never joins this
  // person's undo stack, and incidentally so `readOnly` cannot block it.
  if (frozen || doc.readonly || isReaderCopy(doc)) store.readOnly = true
  const editor = new Editor(document.getElementById('app')!, store)

  // Live collaboration. Constructing the session is enough to make same-machine
  // tabs of one file sync (BroadcastChannel, keyed on docId); the RELAY is not
  // dialled here — the kernel's shareEligible() gate decides that, and it says
  // connect only when the document ARRIVED carrying collab credentials (it was
  // saved or shared) or the user opted in this session. A fresh starter space
  // and a template tire-kicker stay dormant, which is the rule this app already
  // wrote down: "A space does not phone home when it is opened".
  const session = new SyncSession(store)
  editor.connectSync(session)

  if (!frozen && doc.readonly) {
    banner(t('This is a reading copy. It opens for reading; nothing you do here changes the file.'))
  } else if (!frozen && isReaderCopy(doc)) {
    banner(t('This is a view-only copy — it follows the live session but can’t change this space.'))
  }
  if (frozen) {
    banner(frozen === 'version'
      ? t('This file was written by a newer version of bento/spaces. It is open read-only so nothing is lost.')
      : t('This file declares rules this build does not know. It is open read-only so nothing is lost.'))
  }
  if (repaired.length) {
    banner(t('{n} duplicate or missing id(s) were repaired so links and pages resolve.', { n: repaired.length }))
  }

  editor.onSave = () => { void doSave() }
  editor.onSaveAs = (suffix: string) => {
    if (suffix === '__markdown') { downloadMarkdown(store); return }
    store.endRun()
    // "Save a copy…" must leave you editing the ORIGINAL. That is what the
    // label promises, and the file you go on typing into should never silently
    // become the backup you just took.
    //
    // This used to call saveFile(doc, true), under a comment claiming the
    // kernel kept the in-place handle pointed at the working file. It does the
    // opposite: saveFile ASSIGNS the picked handle to the module's in-place
    // handle (kernel/src/save.ts), so every later ⌘S wrote to the copy while
    // the original stayed frozen at the moment it was copied. The guarantee the
    // comment described lives in writeUpdatedFileAs, whose keepHandle defaults
    // to false — slides learned the same lesson when a share export became the
    // ⌘S target and the next save overwrote it with the full document.
    //
    // The status line was dead too: saveFile returns 'saved-as' down the
    // forcePicker path, never 'saved', so the confirmation never appeared.
    void serializeAuto(store.doc)
      .then((html) => writeUpdatedFileAs(html, store.doc, { suffix: suffix === 'copy' ? 'copy' : suffix }))
      .then((ok) => { if (ok) editor.status(t('Copy saved — you are still editing the original')) })
  }
  /**
   * Write a DIFFERENT document out as its own file — the page extract.
   *
   * `serializeAuto`, not `serializeFile`: it is the encryption-aware path, so
   * an extract taken out of a password-protected space is written encrypted
   * with the same password the author is already holding. A page pulled out of
   * an encrypted space arriving in the clear would defeat the encryption
   * silently, on a file whose whole point is that it does not.
   *
   * `keepHandle` stays false (the default), which is the lesson slides paid
   * for: an export that becomes the ⌘S target means the next save overwrites
   * the extract with the whole document.
   */
  editor.onExportSpace = async (out: SpacesDoc): Promise<boolean> => {
    const html = await serializeAuto(out)
    return writeUpdatedFileAs(html, out, { suggestedName: suggestedFileName(out) })
  }

  /**
   * Write a SHARE copy — the invite, or the view-only follower.
   *
   * `out` is a DERIVED document (share.ts), never `store.doc`: that is the
   * whole of the fix for "Invite someone…", which used to reach the ordinary
   * copy path and therefore handed every recipient `collab.ownerPriv`.
   *
   * `serializeAuto`, so an invite taken out of a password-protected space is
   * written encrypted with the password its author is already holding — a
   * shared copy arriving in the clear would defeat the encryption silently.
   *
   * `keepHandle` stays false (the default), and here it is load-bearing rather
   * than tidy: retaining the handle would make the NEXT ⌘S overwrite the copy
   * that just left with the full document — owner key included. Slides paid
   * for that lesson once already.
   */
  editor.onShareCopy = async (out: SpacesDoc, suffix: string): Promise<boolean> => {
    const html = await serializeAuto(out)
    return writeUpdatedFileAs(html, out, { suffix })
  }

  // Two minutes, as in slides. Short enough that a long writing session leaves
  // a usable trail, long enough that the cap is not spent on one afternoon.
  const VERSION_EVERY_MS = 120_000
  let lastVersionAt = 0

  async function doSave(): Promise<void> {
    store.endRun()
    editor.status(t('Saving…'))
    const res = await saveFile(store.doc)
    if (res === 'saved' || res === 'saved-as' || res === 'downloaded') {
      // the document is on disk now — the dot goes out
      store.dirty = false
      editor.syncDirty()
    }
    if (res === 'saved' || res === 'saved-as' || res === 'downloaded') {
      // A SAVE IS THE MOMENT WORTH KEEPING. The throttle below catches long
      // editing runs, but the point somebody chose to write the file is the
      // point they would most want back, so it is never throttled away.
      // Encrypted spaces keep nothing here, for the reason putRecovery does not.
      if (!isEncryptionActive()) { void addVersion(store.doc); lastVersionAt = Date.now() }
    }
    if (res === 'saved') {
      void clearRecovery(store.doc.docId)
      // "Saved" is doing real work here: on a browser without file-system
      // access this was a NEW download, and saying so is the difference
      // between understanding that and losing track of which copy is current
      editor.status(canWriteInPlace() ? t('Saved') : t('Saved a new copy'))
    } else {
      editor.status('')
    }
  }

  // A recovery snapshot is the ONLY backstop on browsers with no file-system
  // access — which is every browser on iOS.
  //
  // NEVER for an encrypted space. The snapshot is the document as plain JSON,
  // so writing one puts in IndexedDB exactly what the password exists to keep
  // off the disk — and it would do it every few seconds, for the one author who
  // demonstrably cares. The kernel's putRecovery does not guard this; the
  // caller must (slides has the same contract).
  //
  // RECOVERY IS NOT HISTORY. putRecovery keeps ONE snapshot per space — the
  // answer to "the tab died", and nothing else. It is overwritten every few
  // seconds, so it cannot answer "put back what I had before lunch", and undo
  // cannot either: the undo stack lives in memory and dies with the reload.
  // Spaces shipped with only the first of those, while slides and dash both
  // keep a timeline. For the app people write PROSE in, that was the wrong one
  // to leave out — a paragraph rewritten badly an hour ago was unrecoverable by
  // any means the app offered.
  //
  // So a version is added on a throttle while editing, and unthrottled on save.
  // The kernel caps and prunes the timeline; both stores stay empty while a
  // password is set.
  let timer: ReturnType<typeof setTimeout> | undefined
  store.on('doc', () => {
    clearTimeout(timer)
    if (isEncryptionActive()) return
    timer = setTimeout(() => {
      void putRecovery(store.doc)
      if (Date.now() - lastVersionAt > VERSION_EVERY_MS) {
        lastVersionAt = Date.now()
        void addVersion(store.doc)
      }
    }, 2500)
  })
  void pruneOld()
  void offerRecovery(doc, store, editor)

  // ---- the AI round-trip (PLATFORM §7) -----------------------------------
  //
  // Every write verb is ONE undoable step, and every one of them runs its plan
  // FIRST: `store.commit` checkpoints undo before it mutates, so planning
  // inside the commit would leave an undo entry behind for a patch that was
  // refused. A refused patch changes nothing at all, including history.
  function run<T extends object>(plan: Plan<T>): ({ ok: true } & T) | PlanError {
    if (store.readOnly) {
      return { ok: false, err: 'readonly', detail: 'this file is open read-only; nothing was changed' }
    }
    if (!plan.ok) return plan
    const { apply, ...rest } = plan
    store.commit(apply)
    editor.repaint()
    return rest as { ok: true } & T
  }

  ;(window as any).bento = {
    format: doc.format,
    get doc() { return store.doc },
    get readonly() { return store.readOnly },
    serialize: () => serializeFile(store.doc),
    serializeAuto: () => serializeAuto(store.doc),
    undo: () => { store.undo(); editor.repaint() },
    redo: () => { store.redo(); editor.repaint() },
    updates: { version: APP_VERSION },
    /**
     * i18n: t/locale/setLocale/choices, as slides exposes it.
     *
     * setLocale('x-pseudo') is the SWEEP AUDIT: every string that reached t()
     * comes back bracketed and accented, so anything still in plain English is
     * a string the extractor never saw and no catalog will ever carry. That is
     * not hypothetical here — two aria-labels were sitting untranslated in this
     * app, and the packer reported 100% the whole time, because a key that is
     * never swept is a key the percentage cannot know about.
     *
     * Chrome only: page titles and block text are the document and must stay
     * exactly as written.
     */
    i18n: i18nApi,
    /** open the graph view — the same thing the ⋯ menu opens */
    graph: () => { editor.openGraph() },
    /** every page, flat — the shape an agent wants before it reads anything */
    pages: () => store.doc.pages.map((p) => ({
      id: p.id, title: p.title, parent: p.parent, archived: !!p.archived, blocks: p.blocks.length,
    })),
    getPage: (id: string) => store.doc.pages.find((p) => p.id === id) ?? null,
    search: (q: string) => {
      const needle = String(q).toLowerCase()
      const out: Array<{ pageId: string; title: string; blockId: string }> = []
      for (const p of store.doc.pages) {
        for (const b of p.blocks) {
          // textOf DECODES entities; a tag-strip does not. On a block reading
          // "a &amp; b" the old regex searched "a &amp; b", so it missed the
          // text the reader can see and matched text that is not there.
          const text = textOf(b.html)
          if (text.toLowerCase().includes(needle)) out.push({ pageId: p.id, title: p.title, blockId: b.id })
        }
      }
      return out
    },
    /** what is WRONG or SUSPECT — see agent.ts */
    validate: (target?: SpacesDoc) => validateDoc(target ?? store.doc),
    /** the whole space as a tree, for orienting in one call */
    outline: (target?: SpacesDoc) => outlineDoc(target ?? store.doc),
    /** where the bytes are */
    stats: (target?: SpacesDoc) => statsDoc(target ?? store.doc),
    /**
     * What a human flagged: every review thread, flat, each with a typed
     * anchor ('block' with a `blockId`, or 'page').
     *
     * READ ONLY, deliberately. The verbs beside it change the document an
     * agent was asked to work on; a comment is the other half of a
     * CONVERSATION, and an agent quietly resolving the remark it was supposed
     * to act on is the one move that makes the record untrue. Filter with
     * `comments({ resolved: false })` for the outstanding ones.
     */
    comments: (query?: CommentQuery) => commentsReport(store.doc, query ?? {}),

    /**
     * ONE undoable step. Without this an agent appending a paragraph has to
     * rewrite and reparse the whole space through loadDoc — clobbering
     * concurrent edits and flattening undo to a single entry.
     *
     * Keeps its original return shape (new ids, or null) because it shipped
     * that way; the verbs below it return tagged results.
     */
    insertBlocks: (pageId: string, afterId: string | null, blocks: unknown[]) => {
      const res = run(planInsertBlocks(store.doc, pageId, afterId ?? null, blocks))
      return res.ok ? res.ids : null
    },
    updateBlock: (id: string, patch: unknown) => run(planUpdateBlock(store.doc, id, patch)),
    removeBlocks: (ids: unknown) => run(planRemoveBlocks(store.doc, ids)),
    moveBlock: (id: string, to: unknown) => run(planMoveBlock(store.doc, id, to)),
    updatePage: (id: string, patch: unknown) => run(planUpdatePage(store.doc, id, patch)),
    removePage: (id: string, opts?: { descendants?: boolean }) =>
      run(planRemovePage(store.doc, id, opts ?? {})),

    // ---- the tracker: an issue is a page ---------------------------------
    /** the schema in force — the option IDS a value must use */
    fields: () => fieldsReport(store.doc),
    /** the backlog as data, filtered by field value or by status phase */
    issues: (query?: IssueQuery) => issuesReport(store.doc, query ?? {}),
    /**
     * One field, one undoable step, `value` and its readable `html` written
     * TOGETHER — the only supported way to set a value, because a prop block
     * written by hand through insertBlocks gets that pairing wrong, and it is
     * the one thing that must never happen.
     */
    setField: (pageId: string, key: string, value: unknown) =>
      run(planSetField(store.doc, pageId, key, value)),
    newIssue: (spec?: unknown) => run(planNewIssue(store.doc, spec)),

    /**
     * A page carries one empty paragraph, exactly as the editor's own New page
     * does. A page with no blocks has nothing to put a caret in — no gutter, no
     * / menu, no way to type — so an agent creating one would hand a human a
     * page they cannot write in.
     */
    /**
     * Today's entry, or any day's — created if it does not exist yet.
     *
     * The same path the button and ⌘⇧J take, so an agent writing a daily note
     * lands in the same page a person would, and calling it twice in a day
     * returns the same page rather than making a second one.
     *
     * `date` is an ISO `YYYY-MM-DD`. Anything else is refused rather than
     * guessed at: "06/08/2026" is two different days depending on who wrote it.
     */
    journal: (date?: string) => {
      if (store.readOnly) return null
      const iso = date === undefined ? todayISO() : String(date)
      if (!isISO(iso)) return null
      editor.openJournal(iso)
      return journalFor(store.doc, iso)?.id ?? null
    },
    /**
     * Work out an expression the way a line ending in `=` would.
     *
     * `bento.calc('20% of 340')` → 68. With a page id, the names defined on
     * that page are in scope, so an agent sees exactly what a reader sees.
     * Returns null for anything the grammar does not fully understand — the
     * same refusal the page makes, rather than a guess.
     */
    calc: (expr: string, pageId?: string) => {
      const page = pageId ? store.index.page.get(pageId) : undefined
      const ctx = page
        ? pageContext(page.blocks.map((b) => ({ id: b.id, text: textOf(b.html ?? '') })), '')
        : {}
      const v = evaluate(String(expr ?? ''), ctx)
      return v ? { value: v.n, text: format(v, locale()) } : null
    },
    newPage: (title: string, parent?: string) => {
      if (store.readOnly) return null
      // A TITLE, not something that stringifies into one. This takes a string
      // where the verbs beside it take an object, so `newPage({ title: 'x' })`
      // is the natural mistake — and it used to make a page called
      // "[object Object]" and hand back its id, which is the exact failure the
      // rest of this surface exists to avoid.
      if (badTitle(title)) return null
      // a parent that names nothing would silently make this a ROOT page; say
      // no instead, so the caller finds out now rather than in the sidebar
      if (parent && !store.doc.pages.some((p) => p.id === parent)) return null
      const page = newPage(plainTitle(title) || 'Untitled', parent ? { parent } : {})
      store.commit(() => { store.doc.pages.push(page) })
      editor.repaint()
      return page.id
    },
    loadDoc: (json: string): boolean => {
      if (store.readOnly) return false
      const r = parseDoc(json)
      if (!r.ok) return false
      store.replaceDoc(r.doc)
      editor.repaint()
      return true
    },
  }

  if (!canWriteInPlace()) {
    // stated rather than discovered — the product-defining limitation on iOS
    console.info('[bento/spaces] this browser cannot write back to the file; every save makes a new copy')
  }

  /**
   * Ask the release server whether this app is current — and NOTHING else.
   *
   * This is the one request bento/spaces makes on its own, and it is worth
   * being precise about how it sits beside "A space does not phone home when
   * it is opened" (DECISIONS, 2026-08-03). That rule is about the DOCUMENT: an
   * author who mails you a file must not learn your address and the moment you
   * opened it, which is what a remote `<img>` delivers. This is the APP asking
   * its own release origin for a signed manifest, on the reader's behalf and
   * under the reader's switch — the same check slides has run at launch since
   * v0.9, reading the same `bento-auto-check` preference, so turning it off in
   * one app turns it off in both. It sends no id, carries nothing from the
   * document, and is the mechanism by which a file that will outlive its
   * browser ever learns that it should be updated.
   *
   * Never fatal, and never in the way: the result only changes a sentence in
   * the About dialog.
   */
  void launchUpdateCheck().catch(() => { /* an unreachable server is not an error here */ })
}

function banner(text: string, actions: Array<[string, () => void]> = []): void {
  const bar = document.createElement('div')
  bar.className = 'sp-banner'
  const span = document.createElement('span')
  span.textContent = text
  bar.append(span)
  for (const [label, fn] of actions) {
    const b = document.createElement('button')
    b.className = 'sp-btn'
    b.textContent = label
    b.addEventListener('click', () => { fn(); bar.remove() })
    bar.append(b)
  }
  const close = document.createElement('button')
  close.className = 'sp-btn'
  close.textContent = '✕'
  close.setAttribute('aria-label', t('Dismiss'))
  close.addEventListener('click', () => bar.remove())
  bar.append(close)
  document.body.prepend(bar)
}

/** A snapshot that differs from the file we loaded means a crash lost work. */
async function offerRecovery(doc: SpacesDoc, store: Store, editor: Editor): Promise<void> {
  const snap = await getRecovery(doc.docId)
  if (!snap) return
  let saved: SpacesDoc
  try { saved = JSON.parse(snap.json) as SpacesDoc } catch { return }
  if (docContentKey(saved) === docContentKey(doc)) return
  banner(t('Unsaved changes from a previous session were found.'), [
    [t('Restore'), () => { store.replaceDoc(saved); editor.repaint() }],
    [t('Discard'), () => { void clearRecovery(doc.docId) }],
  ])
}
