// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Boot sequence for bento/dash.
//
// Order matters: configure the app, then capture the pristine document BEFORE
// any DOM mutation — the captured copy is what gets re-serialized on save.
//
// THE BOOT DISPATCHER IS THE MOST IMPORTANT TWENTY LINES IN THE APP, because
// getting it wrong destroys data rather than merely failing. `parseDoc` returns
// a tagged result and the ONLY state that reaches the starter workbook is an
// absent or empty block. Everything else refuses, says what it found, and
// offers the bytes back untouched — because anything that failed to parse is
// somebody's data, and replacing it with an empty workbook is a loss the first
// ⌘S makes permanent.
//
// And one case the kernel cannot express: `readEmbeddedDoc` returns
// `text || null`, so "no #bento-doc element" and "element present, text node
// empty" arrive identically. Measured, past the parser's limit the block IS
// present with a zero-length text node and no throw — so that must be told
// apart HERE, where the DOM is still visible, or an oversized workbook opens
// as the starter and saves over itself.

import './styles.css'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, saveFile,
  parseEnvelope, decryptEnvelope, setEncryptionPassword, isEncryptionActive,
  canWriteInPlace, downloadFile, suggestedFileName, openedFileName,
} from '../../kernel/src/save.ts'
import { putRecovery, pruneOld } from '../../kernel/src/autosave.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { t } from './i18n.ts'
import {
  parseDoc, docBytes, docBudget, rowCount, DOC_BUDGET_FSA, DOC_BUDGET_DOWNLOAD,
  type DashDoc, type ParseResult, type Column, type ColumnType, type TableSheet,
} from './model.ts'
import { Store } from './store.ts'
import { starterDoc } from './starter.ts'
import { Grid } from './grid.ts'
import { importDelimited } from './import.ts'
import { TYPE_LABEL } from './format.ts'

configureApp({
  appId: 'bento-dash',
  appName: 'bento/dash',
  manifestUrl: 'https://bento.page/releases/dash/manifest.json',
})

capturePristine()

// --- boot -------------------------------------------------------------------

const blockEl = document.getElementById('bento-doc')
const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null

if (envelope) {
  void passwordGate(embedded!)
} else if (blockEl && embedded === null && (blockEl.textContent ?? '').length > 0) {
  // present, non-empty, and yet unreadable — the case the kernel flattens
  refuse({ ok: false, err: 'unreadable', detail: t('The document block is present but could not be read.') })
} else {
  const res = parseDoc(embedded ?? '')
  if (res.ok) boot(res.doc, res.repairs.length, res.frozen)
  else if (res.err === 'empty') boot(starterDoc(), 0, undefined)
  else refuse(res)
}

/** An encrypted workbook: ask, then take the same boot path. */
async function passwordGate(raw: string): Promise<void> {
  document.getElementById('bento-splash')?.remove()
  document.body.innerHTML =
    `<div class="dx-gate"><h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter the password to open this workbook.')}</p>` +
    `<input type="password" class="dx-title" autocomplete="current-password" style="width:100%">` +
    `<p><button class="dx-btn dx-unlock">${t('Unlock')}</button> <span class="dx-err"></span></p></div>`
  const input = document.querySelector<HTMLInputElement>('input')!
  const err = document.querySelector<HTMLElement>('.dx-err')!
  const tryUnlock = async () => {
    const env = parseEnvelope(raw)
    if (!env || !input.value) return
    const json = await decryptEnvelope(env, input.value)
    if (json === null) { err.textContent = t('Wrong password — try again'); input.select(); return }
    const res = parseDoc(json)
    if (!res.ok) { err.textContent = t('Unlocked, but the workbook inside could not be read.'); return }
    setEncryptionPassword(input.value)
    document.body.innerHTML = '<div id="app"></div>'
    boot(res.doc, res.repairs.length, res.frozen)
  }
  document.querySelector('.dx-unlock')!.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryUnlock() })
  input.focus()
}

/**
 * The refusal surface. It never opens an editor, so nothing downstream can
 * serialize: `boot()` is where the Store, the save handler and the autosave
 * subscription are constructed, and none of them exist on this path.
 */
function refuse(res: Extract<ParseResult, { ok: false }>): void {
  document.getElementById('bento-splash')?.remove()
  const why = res.err === 'empty' ? '' : 'detail' in res ? res.detail : ''
  const found = 'found' in res && res.found ? ` (${res.found})` : ''
  document.body.innerHTML =
    `<div class="dx-gate">` +
    `<h1>${t('This file could not be opened as a bento/dash workbook.')}</h1>` +
    `<p>${esc(why)}${esc(found)}</p>` +
    `<p>${t('Your data has not been changed, and this build will not write to this file. You can take the contents out below.')}</p>` +
    `<code id="dx-raw"></code>` +
    `<button class="dx-btn" id="dx-copy">${t('Copy document JSON')}</button>` +
    `<button class="dx-btn" id="dx-download">${t('Save an untouched copy')}</button>` +
    `</div>`
  const raw = readEmbeddedDoc() ?? ''
  document.getElementById('dx-raw')!.textContent = raw.slice(0, 4000) || t('(the document block is empty)')
  document.getElementById('dx-copy')!.addEventListener('click', () => {
    void navigator.clipboard?.writeText(raw)
  })
  document.getElementById('dx-download')!.addEventListener('click', () => {
    // the file exactly as it arrived — no parse, no re-serialize
    downloadFile(document.documentElement.outerHTML, openedFileName() ?? 'recovered.bento.html')
  })
}

// --- the app ----------------------------------------------------------------

function boot(doc: DashDoc, repaired: number, frozen?: 'policy' | 'version'): void {
  document.title = `${doc.title} — ${appConfig().appName}`
  document.getElementById('bento-splash')?.remove()

  const store = new Store(doc)
  if (frozen) store.readOnly = true

  const app = document.getElementById('app')!
  app.innerHTML =
    `<header class="dx-bar">` +
    `<span class="dx-mark">bento<span>/</span>dash</span>` +
    `<input class="dx-title" value="">` +
    `<span class="dx-dirty" hidden>•</span>` +
    `<button class="dx-btn" data-act="import">${t('Import CSV…')}</button>` +
    `<button class="dx-btn" data-act="undo">${t('Undo')}</button>` +
    `<button class="dx-btn" data-act="export">${t('Export CSV')}</button>` +
    `<button class="dx-btn" data-act="save">${t('Save')}</button>` +
    `<span class="dx-ver">v${APP_VERSION}</span>` +
    `</header>` +
    `<div class="dx-findings" hidden></div>` +
    `<div class="dx-grid"></div>`

  const titleEl = app.querySelector<HTMLInputElement>('.dx-title')!
  const dirtyEl = app.querySelector<HTMLElement>('.dx-dirty')!
  const findingsEl = app.querySelector<HTMLElement>('.dx-findings')!
  titleEl.value = doc.title
  titleEl.disabled = store.readOnly

  const grid = new Grid({ el: app.querySelector<HTMLElement>('.dx-grid')!, store, sheetId: doc.sheets[0].id })
  grid.onRetype = (col) => retype(store, col)

  const notes: Notice[] = []
  if (frozen) {
    notes.push({
      message: frozen === 'version'
        ? t('This workbook was written by a newer version of dash. It is open read-only so nothing is lost.')
        : t('This workbook declares rules this build does not know. It is open read-only so nothing is lost.'),
    })
  }
  if (repaired) {
    notes.push({ message: t('{n} duplicate or missing id(s) were repaired so references resolve.').replace('{n}', String(repaired)) })
  }
  showFindings(findingsEl, notes)

  // --- dirty + autosave
  let dirty = false
  let timer: number | undefined
  const markDirty = () => {
    dirty = true
    dirtyEl.hidden = false
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      // NEVER write an encrypted workbook's plaintext to IndexedDB. The kernel
      // states the rule in its own header and enforces it in neither place, so
      // every app has to remember — and the second one did not.
      if (!isEncryptionActive()) void putRecovery(store.doc)
    }, 2500)
  }
  store.on('doc', markDirty)
  void pruneOld()

  titleEl.addEventListener('input', () => {
    store.commit({ op: 'setTitle', title: titleEl.value })
    document.title = `${titleEl.value} — ${appConfig().appName}`
  })

  // --- actions
  app.querySelector('[data-act="save"]')!.addEventListener('click', () => { void doSave() })
  app.querySelector('[data-act="undo"]')!.addEventListener('click', () => { store.undo() })
  app.querySelector('[data-act="export"]')!.addEventListener('click', () => exportCsv(store))
  app.querySelector('[data-act="import"]')!.addEventListener('click', () => {
    void pickCsv(store, findingsEl, grid)
  })
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === 's') { e.preventDefault(); void doSave() }
    else if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); store.redo() }
  })
  document.addEventListener('paste', (e) => {
    if ((e.target as HTMLElement)?.isContentEditable) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text || !/[,;\t]/.test(text.split('\n')[0] ?? '')) return
    e.preventDefault()
    applyImport(store, findingsEl, grid, text, 'pasted')
  })

  async function doSave(): Promise<void> {
    if (store.readOnly) return
    // Budget check before every write that grows the document. Not a refusal:
    // the user is told what will actually break, in this browser, and decides.
    const bytes = docBytes(store.doc)
    const budget = docBudget(canWriteInPlace())
    if (bytes > budget) {
      const mb = (bytes / 1024 / 1024).toFixed(1)
      const how = canWriteInPlace()
        ? t('Saving will take a moment.')
        : t('This browser has no in-place save, so every save downloads the whole file.')
      if (!window.confirm(`${t('This workbook is {mb} MB.').replace('{mb}', mb)} ${how} ${t('Save anyway?')}`)) return
    }
    const r = await saveFile(store.doc)
    if (r === 'saved' || r === 'downloaded') { dirty = false; dirtyEl.hidden = true }
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty && !store.readOnly) { e.preventDefault(); e.returnValue = '' }
  })

  // --- the scripting/agent surface
  ;(window as unknown as Record<string, unknown>).bento = {
    format: doc.format,
    get doc() { return store.doc },
    serialize: () => serializeFile(store.doc),
    serializeAuto: () => serializeAuto(store.doc),
    undo: () => store.undo(),
    redo: () => store.redo(),
    /** patch the workbook — the same objects the store, undo and future ops use */
    commit: (p: unknown) => { store.commit(p as never) },
    importCsv: (text: string, name?: string) => applyImport(store, findingsEl, grid, text, name ?? 'pasted'),
    loadDoc: (json: string): boolean => {
      const r = parseDoc(json)
      if (!r.ok) return false
      store.replaceDoc(r.doc)
      return true
    },
    stats: () => ({ rows: rowCount(store.doc), bytes: docBytes(store.doc), budget: docBudget(canWriteInPlace()) }),
  }
}

// --- import -----------------------------------------------------------------

async function pickCsv(store: Store, host: HTMLElement, grid: Grid): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.csv,.tsv,.txt,text/csv,text/plain'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (!f) return
    void f.text().then((text) => applyImport(store, host, grid, text, f.name))
  })
  input.click()
}

function applyImport(store: Store, host: HTMLElement, grid: Grid, text: string, source: string): void {
  const sheetId = `sheet-${Math.floor(Date.now() % 1e8).toString(36)}`
  const r = importDelimited(text, {
    name: source.replace(/\.[a-z]+$/i, '') || 'Imported',
    sheetId,
    source,
    at: new Date().toISOString(),
  })
  store.commit({ op: 'setTitle', title: store.doc.title })  // one checkpoint boundary
  store.doc.sheets.push(r.sheet)
  store.replaceDoc(store.doc)
  grid.setSheet(sheetId)
  showFindings(host, r.findings)
}

/**
 * One line in the banner. Import findings and boot notices share a surface
 * because they answer the same question — "what did opening this file decide
 * on my behalf?" — so they get one type rather than one borrowed from import.
 */
interface Notice { message: string }

function showFindings(host: HTMLElement, findings: Notice[]): void {
  if (!findings.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = findings.map((f) =>
    `<div class="dx-f"><span class="dx-dot">●</span><span>${esc(f.message)}</span></div>`).join('')
}

/** The correctable half of the type row: import guesses, you settle it. */
function retype(store: Store, col: Column): void {
  const types: ColumnType[] = ['text', 'number', 'money', 'percent', 'date', 'bool']
  const list = types.map((tp, i) => `${i + 1}. ${TYPE_LABEL[tp]}`).join('\n')
  const pick = window.prompt(`${t('Column type for')} "${col.name}"\n\n${list}`,
    String(types.indexOf(col.type) + 1))
  if (!pick) return
  const next = types[Number(pick) - 1]
  if (!next || next === col.type) return
  const sheet = store.doc.sheets.find((s) =>
    s.kind === 'table' && s.columns.some((c) => c.id === col.id)) as TableSheet | undefined
  if (!sheet) return
  store.commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { type: next } })
}

// --- export -----------------------------------------------------------------

function exportCsv(store: Store): void {
  const sheet = store.doc.sheets.find((s) => s.kind === 'table') as TableSheet | undefined
  if (!sheet) return
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const lines = [sheet.columns.map((c) => q(c.name)).join(',')]
  for (let i = 0; i < n; i++) {
    lines.push(sheet.columns.map((c) => {
      const d = sheet.data[c.id]
      const v = d?.enc === 'raw' ? d.v[i] : d?.enc === 'dict' ? (d.idx[i] == null ? null : d.dict[d.idx[i]!]) : null
      return q(v == null ? '' : String(v))
    }).join(','))
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${suggestedFileName(store.doc).replace(/\.bento\.html$/, '')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// referenced so the budget constants are not tree-shaken out of the bundle,
// and so a reader of this file sees both halves of the rule in one place
void DOC_BUDGET_FSA
void DOC_BUDGET_DOWNLOAD
