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
  canWriteInPlace, downloadFile, suggestedFileName, openedFileName, registerPreview,
  currentFileName,
} from '../../kernel/src/save.ts'
import { putRecovery, pruneOld } from '../../kernel/src/autosave.ts'
import { FileWriteBack } from './writeback.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { mountAbout, openAbout, rememberVersion, checkAtLaunch } from './about.ts'
import { runSql, sqlRows } from './sql.ts'
import { mountPanels, type Panels } from './panels.ts'
import { installStory } from './story.ts'
import { Dashboard } from './dashboard.ts'
import { SyncSession } from './sync/session.ts'
import { mountPeople } from './sync/people.ts'
import { ridBase, ridBlockFor, docForExport } from './model.ts'
import { setRidBlock } from './rowcol.ts'
import { importXlsx, installNames, exportXlsx, xlsxFileName } from './xlsx.ts'
import { runPivot, mountPivot, defaultPivot, newPivotSheet, type PivotSpec } from './pivot.ts'
import { buildSheetPreview } from './preview.ts'
import { installPrint, openPrintDialog } from './print.ts'
import './ask.css'
import { openColumnMenu } from './filterui.ts'
import { installSaveMenu, adoptOpenedDoc, toast } from './saveui.ts'
import { dismissSplash, dismissSplashNow } from './splash.ts'
import { t, i18nApi } from './i18n.ts'
import {
  parseDoc, docBytes, docBudget, rowCount, DOC_BUDGET_FSA, DOC_BUDGET_DOWNLOAD,
  type DashDoc, type ParseResult, type Column, type ColumnType, type TableSheet,
  type Sheet, type CanvasSheet,
} from './model.ts'
// THE ONE TABLE that says which toolbar actions run on which sheet kind, and
// why the others do not. It lives in tabs.ts because that is where the app
// already keeps what a KIND is (`isTable`, `isOpenable`, `describeKind`) and
// because a rig can import it with no DOM — main.ts boots on evaluation, so it
// can never be imported at all. See the block above `ACTIONS` for the rest.
import {
  ACTIONS, ACTION_IDS, actionReason, mintSheetId, mintSheetName, type ActionId,
} from './tabs.ts'
// The bridge between the two kinds of sheet — pure, and tested with no DOM in
// `scripts/test-dash-promote.ts`. Everything below is the gesture; every
// decision (types, the header row, what happens to a cell formula) is there.
import {
  promoteRange, flattenToSpreadsheet, describeBox, detectHeader, trimBox, currentRegion,
  type CellBox, type CanvasView, type PromoteFinding,
} from './promote.ts'
import { cellKey, isFormula, recalcWorkbook, workbookSources } from './cellformula.ts'
import { Store, type Patch, setColumnType } from './store.ts'
import { starterDoc } from './starter.ts'
import { inferComputedType } from './computedtype.ts'
import { validateDoc } from './validate.ts'
import { mountHelp } from './help.ts'
// The grid's three context menus, and the popover every menu in this file is
// drawn in. They live outside main.ts because main.ts BOOTS ON EVALUATION and
// so can never be imported by a rig — and a context menu whose items nothing
// asserts is exactly how findings 5 and 8 shipped. See gridmenu.ts's header.
import { popover, installGridMenus, type MenuHooks } from './gridmenu.ts'
import { keyToAction, normalize } from './select.ts'
import {
  appearancePatch, overrideKeys, ridAt, toggleTarget,
  type AppearanceField, type CellRange,
} from './cellfmt.ts'
import { rangeKeys, stylePatch } from './cellprops.ts'
import { mountComments, flatComments } from './comments.ts'
import { mountRecovery } from './recovery.ts'
import { mountDropOpen } from './dropopen.ts'
import { Grid, canvasKey, CANVAS_MAX_ROWS, CANVAS_MAX_COLS } from './grid.ts'
// Paste Special and Text to Columns. Both are DOM-free decisions with their
// own rigs (scripts/test-dash-pastespecial.ts, scripts/test-dash-tocolumns.ts);
// what lives in this file is only the gesture that calls them.
import {
  planPasteSpecial, pasteSpecialItems, pickLook, canvasPastePatches, tablePastePatches,
  type Clip, type ClipCell, type PasteRefusal, type PasteSpecialItem, type PasteWhat,
} from './pastespecial.ts'
import { planTableSplit, planCanvasSplit, type SplitSpec } from './tocolumns.ts'
import { importDelimited } from './import.ts'
import { TYPE_LABEL } from './format.ts'
import { defaultBinding, renderChart, chartHeading, missingColumns, type ChartBinding } from './chart.ts'
import { readCell } from './store.ts'
import { hiddenSet } from './rowcol.ts'
import { FUNCTIONS, dependencies, recalc } from './formula.ts'
import { buildScene, defaultViz3d, mountViz3d, type Viz3dBinding, type Viz3dKind } from './viz3d.ts'

// --- topbar icons -----------------------------------------------------------
//
// Every top-bar control carries an icon AND a <span> label, because that is the
// only shape that survives a narrow window: under 1280px the CSS hides the
// spans and the icons carry on alone (slides/src/styles.css does the same, and
// its comment — "labels give way, never a scrollbar" — is the whole rule). A
// label-only button has nothing left to shrink to, which is exactly how this
// bar came to be 1436px wide inside an 802px window with Save off the end.
//
// 15px box, 1.6px strokes, currentColor: they have to read at 100% and at the
// 0.45 opacity a disabled button gets.
const SVG = (d: string): string =>
  `<svg class="dx-i" viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" ` +
  `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

const ICON = {
  plus: SVG('<path d="M10 4v12M4 10h12"/>'),
  fx: SVG('<path d="M12 4.5h-1.2a2 2 0 0 0-2 2V16"/><path d="M6.5 9.5h5"/><path d="M13 11l4 5M17 11l-4 5"/>'),
  chart: SVG('<path d="M3.5 16.5h13"/><path d="M6.5 16.5v-5M10 16.5V5.5M13.5 16.5v-8"/>'),
  cube: SVG('<path d="M10 2.8l6 3.4v7.6l-6 3.4-6-3.4V6.2z"/><path d="M4 6.2l6 3.4 6-3.4M10 9.6v7.6"/>'),
  pivot: SVG('<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="1.6"/><path d="M3.2 8h13.6M8 3.2v13.6"/>'),
  dashboard: SVG('<rect x="3.2" y="3.2" width="6" height="6" rx="1.2"/><rect x="10.8" y="3.2" width="6" height="6" rx="1.2"/>' +
    '<rect x="3.2" y="10.8" width="6" height="6" rx="1.2"/><rect x="10.8" y="10.8" width="6" height="6" rx="1.2"/>'),
  story: SVG('<rect x="2.8" y="4" width="14.4" height="9.6" rx="1.4"/><path d="M7 17h6"/>'),
  undo: SVG('<path d="M7 7H4.5V4.5"/><path d="M4.9 7.4A5.6 5.6 0 1 1 4.4 12"/>'),
  // The mirror of undo, because that is what every toolbar in the world uses
  // and a redo arrow that is not undo's reflection reads as a refresh button.
  redo: SVG('<path d="M13 7h2.5V4.5"/><path d="M15.1 7.4A5.6 5.6 0 1 0 15.6 12"/>'),
  data: SVG('<ellipse cx="10" cy="5.4" rx="5.6" ry="2.4"/><path d="M4.4 5.4v9.2c0 1.3 2.5 2.4 5.6 2.4s5.6-1.1 5.6-2.4V5.4"/><path d="M4.4 10c0 1.3 2.5 2.4 5.6 2.4s5.6-1.1 5.6-2.4"/>'),
  // Import and export get OPPOSITE arrows, not two copies of the cylinder. Four
  // rows reading "Import CSV / Export CSV / Import Excel / Export Excel" behind
  // the same glyph is four rows you have to read word by word; the arrow is
  // what lets you find the one you meant at a glance.
  imp: SVG('<path d="M10 3v8.5"/><path d="M6.6 8.2L10 11.6l3.4-3.4"/><path d="M4.2 13.6v2.2h11.6v-2.2"/>'),
  exp: SVG('<path d="M10 11.6V3.1"/><path d="M6.6 6.5L10 3.1l3.4 3.4"/><path d="M4.2 13.6v2.2h11.6v-2.2"/>'),
  save: SVG('<path d="M4.4 3.6h8.3l3.3 3.3v9.5H4.4z"/><path d="M7 3.6v4.2h5V3.6"/><path d="M7 16.4v-4.6h6v4.6"/>'),
  info: SVG('<circle cx="10" cy="10" r="7"/><path d="M10 9.2v4.4"/><path d="M10 6.6h.01"/>'),
  // A printer: the paper going in at the top, the platen, the sheet coming out.
  // Not another arrow — Import and Export own those, and a third would make the
  // menu three rows of the same glyph again.
  print: SVG('<path d="M6 8V3.6h8V8"/><rect x="3.4" y="8" width="13.2" height="5.4" rx="1.2"/>' +
    '<path d="M6 11.6h8v4.8H6z"/>'),
  down: SVG('<path d="M6 8l4 4 4-4"/>'),
} as const

/** A top-bar button: icon + collapsible label, the one shape the bar can shrink. */
const barBtn = (act: string, icon: string, label: string, tip: string, extra = ''): string =>
  `<button class="dx-btn${extra}" data-act="${act}" title="${esc(tip)}">${icon}<span>${esc(label)}</span></button>`

configureApp({
  appId: 'bento-dash',
  appName: 'bento/dash',
  manifestUrl: 'https://bento.page/releases/dash/manifest.json',
})

capturePristine()

// The file-manager thumbnail. Registered BEFORE any save can happen: a save
// that ran first would write a shell with no preview in it, and the next
// thumbnail request would show the boot splash again.
registerPreview(buildSheetPreview)

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
  // A TEMPLATE is a tyre-kicker's document, not an owner's: it mints a fresh
  // docId on open, so it is not a file anybody has saved yet.
  if (res.ok) boot(res.doc, res.repairs.length, res.frozen, !res.doc.template)
  else if (res.err === 'empty') boot(starterDoc(), 0, undefined)   // starter: never checks
  else refuse(res)
}

/** An encrypted workbook: ask, then take the same boot path. */
async function passwordGate(raw: string): Promise<void> {
  dismissSplashNow()
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
    boot(res.doc, res.repairs.length, res.frozen, true)   // encrypted: unambiguously somebody's file
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
  dismissSplashNow()
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

  // THIS SCREEN SHOWED AND COPIED THE CREDENTIALS. #338 stripped `collab` from
  // About's "Copy document JSON"; this is the OTHER button with that label, and
  // it was missed because it copies the raw block rather than a stringified
  // document — so the rig, which looks for a document reaching a clipboard,
  // could not see it either.
  //
  // It matters more here than it looks. The refusal a reader actually hits is
  // `format` — a workbook written by a NEWER dash, or another Bento app — and
  // that block is perfectly good JSON with live keys in it. The screen invites
  // exactly the wrong next step twice over: it prints the text under "take the
  // contents out below", and an error screen is the thing people screenshot and
  // paste into a chat window.
  //
  // So: parse what we can and strip through the SAME `docForExport` the other
  // button uses — one stripper, and it removes rather than allow-lists. When
  // the block is not JSON at all there is nothing to strip safely, and
  // recovering the reader's data matters more than tidiness, so the raw text
  // stands and the note says what is in it. "Save an untouched copy" beside
  // this is the byte-exact route either way, which is why stripping here costs
  // nothing.
  const stripped = ((): { text: string; safe: boolean } => {
    try {
      const o: unknown = JSON.parse(raw)
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { text: raw, safe: false }
      if (!('collab' in (o as Record<string, unknown>))) return { text: raw, safe: true }
      return { text: JSON.stringify(docForExport(o as never), null, 2), safe: true }
    } catch { return { text: raw, safe: false } }
  })()

  const shown = stripped.text
  document.getElementById('dx-raw')!.textContent = shown.slice(0, 4000) || t('(the document block is empty)')
  if (raw && !stripped.safe && raw.includes('"collab"')) {
    const warn = document.createElement('p')
    warn.className = 'dx-gate-warn'
    warn.textContent = t('This block is not readable as JSON, so its collaboration keys could not be removed from what is shown or copied. Use “Save an untouched copy” to keep the file, and take care where you paste this.')
    document.getElementById('dx-raw')!.after(warn)
  } else if (shown !== raw) {
    const said = document.createElement('p')
    said.className = 'dx-gate-note'
    said.textContent = t('The collaboration keys have been left out of what is shown and copied. “Save an untouched copy” keeps the file exactly as it arrived.')
    document.getElementById('dx-raw')!.after(said)
  }
  document.getElementById('dx-copy')!.addEventListener('click', () => {
    void navigator.clipboard?.writeText(shown)
  })
  document.getElementById('dx-download')!.addEventListener('click', () => {
    // the file exactly as it arrived — no parse, no re-serialize
    downloadFile(document.documentElement.outerHTML, openedFileName() ?? 'recovered.bento.html')
  })
}

// --- the app ----------------------------------------------------------------

/**
 * `saved` defaults to the SAFE answer. A workbook nobody has saved must never
 * contact the release channel (PLATFORM §5) — and the shipped shell's
 * `#bento-doc` is EMPTY, so the demo and every fresh download boot the starter
 * through that path. Defaulting to false means a new call site that forgets
 * this argument stays silent rather than phoning home.
 */
function boot(doc: DashDoc, repaired: number, frozen?: 'policy' | 'version', saved = false): void {
  document.title = `${doc.title} — ${appConfig().appName}`
  dismissSplash()

  const store = new Store(doc)
  if (frozen) store.readOnly = true
  // A template mints a fresh docId on open; a read-only copy locks the store
  // (and with it the title field, which reads store.readOnly below).
  adoptOpenedDoc(doc, store)

  const app = document.getElementById('app')!
  app.innerHTML =
    // THE BAR IS GROUPED, AND IT NEVER SCROLLS. It used to be thirteen flat
    // buttons: measured at an 802px window its scrollWidth was 1436px, and the
    // controls hanging off the right edge included Save — the one control the
    // whole application exists to reach. The layout strategy is slides':
    // labels give way to icons, then whole groups fold into menus, and a
    // horizontal scrollbar is never the answer (see styles.css "responsive
    // top bar" for the widths and what happens at each).
    //
    // The grouping is a spreadsheet's, not an alphabet: identity · insert ·
    // (right) history · data in-out · save · about. Import/export live behind
    // ONE menu at every width — four buttons for something done twice a
    // session is what pushed Save off screen in the first place.
    `<header class="dx-bar">` +
    // THE MARK IS THE SAME GLYPH IN EVERY BENTO APP — a bento box, one tall
    // compartment and two stacked — because it is the SUITE's mark and the
    // wordmark beside it is what says which app you are in. Copied from
    // slides' `ed-logo` rather than re-drawn: two hand-maintained copies of a
    // logo drift, and the peach is already `--slash` here.
    // It is also the piece that SURVIVES the responsive collapse (see the
    // rungs in styles.css): 20px of mark costs less than "bento/dash" in text
    // and leaves a phone-width bar with an identity instead of a blank corner.
    `<span class="dx-mark">` +
    `<svg class="dx-mark-svg" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">` +
    `<rect width="32" height="32" rx="7" fill="#16273E"/>` +
    `<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>` +
    `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>` +
    `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>` +
    `</svg>` +
    `<span class="dx-mark-t"><span class="dx-mark-b">bento</span><span class="dx-slash">/</span>dash</span>` +
    `</span>` +
    `<input class="dx-title" value="">` +
    // Insert group. `display: contents` at wide widths (the six buttons sit in
    // the bar); a real dropdown below 1040px, where they do not fit. No JS
    // reparenting, so every listener below keeps working at every width.
    `<div class="dx-dd dx-insert-dd">` +
    `<button class="dx-btn dx-dd-trig" data-dd="insert" title="${esc(t('Insert a formula column, chart, pivot, dashboard or story'))}">` +
    `${ICON.plus}<span>${t('Insert')}</span>${ICON.down}</button>` +
    `<div class="dx-menu">` +
    barBtn('formula', ICON.fx, t('Formula'), t('Add a formula column')) +
    barBtn('chart', ICON.chart, t('Chart'), t('Chart the selected columns')) +
    barBtn('viz3d', ICON.cube, t('3D'), t('Plot three numeric columns in 3D')) +
    barBtn('pivot', ICON.pivot, t('Pivot'), t('Summarise this sheet as a pivot table')) +
    barBtn('dashboard', ICON.dashboard, t('Dashboard'), t('Show or hide the dashboard')) +
    barBtn('story', ICON.story, t('Story'), t('Build a data story from saved views')) +
    `</div></div>` +
    `<div class="dx-group dx-bar-end">` +
    barBtn('undo', ICON.undo, t('Undo'), t('Undo (⌘Z)')) +
    // ⌘⇧Z and ⌘Y both worked and the shortcut card documented them, but the bar
    // had undo alone — so a mouse user who over-undid had no way back at all.
    barBtn('redo', ICON.redo, t('Redo'), t('Redo (⇧⌘Z)')) +
    `<div class="dx-dd dx-data-dd">` +
    `<button class="dx-btn dx-dd-trig" data-dd="data" title="${esc(t('Import and export CSV and Excel files'))}">` +
    `${ICON.data}<span>${t('Data')}</span>${ICON.down}</button>` +
    `<div class="dx-menu">` +
    barBtn('import', ICON.imp, t('Import CSV…'), t('Add a sheet from a CSV or TSV file')) +
    barBtn('export', ICON.exp, t('Export CSV'), t('Download this sheet as CSV')) +
    `<div class="dx-menu-sep"></div>` +
    barBtn('import-xlsx', ICON.imp, t('Import Excel…'), t('Add sheets from an .xlsx workbook')) +
    barBtn('export-xlsx', ICON.exp, t('Export Excel'), t('Download this workbook as .xlsx')) +
    `<div class="dx-menu-sep"></div>` +
    // PAPER IS AN EXPORT, and it belongs with the other three rather than as a
    // fourteenth flat button — the bar's own rule (see the grouping note
    // above). It is the only one of them that prints EVERY row of the view
    // rather than what the windowed grid happens to be showing; print.ts says
    // why that needed a page builder rather than a stylesheet.
    barBtn('print', ICON.print, t('Print…'), t('Print the view, or save it as a PDF (⌘P)')) +
    `</div></div>` +
    // Save keeps its label all the way down to a phone: it is the control the
    // user names when it is missing, and an unlabelled floppy is a guess.
    // The unsaved dot badges its corner rather than floating loose in the bar,
    // where it explained nothing (slides made the same move).
    `<button class="dx-btn dx-btn-save" data-act="save" title="${esc(t('Save this workbook (⌘S)'))}">` +
    `${ICON.save}<span class="dx-save-lab">${t('Save')}</span><span class="dx-dirty" hidden></span>` +
    // The write-back tag. Visible if you look, ignorable if you don't — the
    // whole promise of automatic saving is that you stop watching for it, so a
    // toast every 2.5s would be the wrong shape (a failure gets the toast).
    // INSIDE the button because `.dx-btn-save` is the only `position: relative`
    // box here, and the tag must be absolutely positioned: appearing must not
    // move Save, which is the control that has to survive every width.
    `<span class="dx-wb" hidden></span></button>` +
    // SETTINGS GETS ITS OWN DOOR. About used to hold everything — identity,
    // properties, updates, language, appearance, password, history, JSON —
    // eight sections and 3.2 screens of scroll, so somebody hunting for the
    // language picker scrolled past their own password. The split follows the
    // seam the codebase already had: what travels IN THE FILE is About's, what
    // follows THE READER and lives in this browser is Settings'.
    // `mountAbout` wires this on sight and the app is unharmed without it.
    barBtn('settings', SVG('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2L4.8 4.8"/>'), t('Settings'), t('Settings — language, appearance and updates')) +
    barBtn('about', ICON.info, t('About'), t('About this workbook')) +
    `<span class="dx-ver">v${APP_VERSION}</span>` +
    `</div>` +
    `</header>` +
    `<div class="dx-formula"><span class="dx-ref">A1</span>` +
    `<span class="dx-fx-mark">fx</span>` +
    `<input class="dx-fx-input" spellcheck="false" placeholder="${t('value or = formula')}">` +
    // THE BRIDGE, and it lives here rather than in the top bar for two reasons.
    // It is about the SELECTION, which is what this row is already about — and
    // the toolbar's `data-act` namespace is a closed table in tabs.ts that says
    // which actions run on which kind, while this control is the one thing that
    // is available on BOTH kinds and means something different on each. Its
    // label says which (`syncBridge`).
    `<button class="dx-btn dx-bridge" data-cmd="bridge" hidden style="flex:0 0 auto;margin-inline-start:8px"></button>` +
    `</div>` +
    `<div class="dx-findings" hidden></div>` +
    `<div class="dx-body"><div class="dx-grid"></div>` +
    `<div class="dx-dash" hidden></div>` +
    `<div class="dx-chart" hidden><div class="dx-chart-head">` +
    `<span class="dx-chart-title"></span>` +
    `<button class="dx-btn dx-chart-kind">${t('Bar')}</button>` +
    `<button class="dx-btn dx-chart-close" title="${t('Hide chart')}">✕</button>` +
    `</div><div class="dx-chart-body"></div></div></div>` +
    `<footer class="dx-status"><span class="dx-status-view"></span>` +
    `<span class="dx-status-sum"></span></footer>`

  const titleEl = app.querySelector<HTMLInputElement>('.dx-title')!
  const dirtyEl = app.querySelector<HTMLElement>('.dx-dirty')!
  const findingsEl = app.querySelector<HTMLElement>('.dx-findings')!
  titleEl.value = doc.title
  titleEl.disabled = store.readOnly

  const refEl = app.querySelector<HTMLElement>('.dx-ref')!
  const fxEl = app.querySelector<HTMLInputElement>('.dx-fx-input')!
  const sumEl = app.querySelector<HTMLElement>('.dx-status-sum')!
  const viewEl = app.querySelector<HTMLElement>('.dx-status-view')!

  const grid = new Grid({ el: app.querySelector<HTMLElement>('.dx-grid')!, store, sheetId: doc.sheets[0].id })

  // --- can this action run on the sheet in front of the reader? ---------------
  //
  // TWO HALVES, AND BOTH ARE NEEDED. The table (tabs.ts `ACTIONS`) decides; this
  // is where its answer reaches the reader, in both the places it has to:
  //
  //   1. `gateActions` DISABLES the button and puts the reason in its tooltip,
  //      so the answer is there before the click. Never hides it: a control that
  //      vanishes reads as a bug in the app, while a greyed one that says
  //      "Charts bind to a dataset's columns — this is a spreadsheet" teaches
  //      the difference the two kinds exist to express.
  //   2. `dataset()` re-asks at the CALL SITE, because a disabled button is not
  //      a guarantee. A click can already be in flight when a collaborator's op
  //      deletes the sheet, `store.replaceDoc` swaps every sheet under the bar
  //      (About's restore, drop-open, recovery), and a menu item clicked as the
  //      grid changes sheets runs against the new one. Before this, all of those
  //      landed on `grid.sheet`, whose throw is `Uncaught Error: grid needs a
  //      table sheet` — a console line under an app whose console nobody has
  //      open, with nothing on screen at all.
  //
  // Both read the same string from the same table, so a reader who clicks
  // anyway is told exactly what the tooltip said rather than something new.

  /** The sheet on screen, whatever its kind — `grid.sheet` narrows and throws. */
  const shownSheet = (): Sheet | undefined =>
    store.doc.sheets.find((s) => s.id === grid.showingId())

  /** Its kind, or `''` when the grid points at nothing that is still there. */
  const shownKind = (): string =>
    String((shownSheet() as { kind?: unknown } | undefined)?.kind ?? '')

  /**
   * The dataset this action needs — or null, HAVING SAID WHY, through the same
   * banner every other refusal in this file uses. Never a throw, and never
   * silence: doing nothing at all is what taught people the toolbar is
   * decorative.
   */
  const dataset = (act: ActionId): TableSheet | null => {
    const sheet = shownSheet()
    if (sheet && sheet.kind === 'table') return sheet
    showFindings(findingsEl, [{
      message: actionReason(act, shownKind()) ||
        t('This action needs a dataset sheet, and the sheet on screen is not one.'),
    }])
    // The bar disagreed with the document for as long as it took to click, so
    // put it right on the way out.
    gateActions(true)
    return null
  }

  /**
   * Paint the table onto the bar.
   *
   * WORKBOOK-SCOPED ACTIONS ARE SKIPPED ENTIRELY rather than enabled: Undo,
   * Redo and Save have owners of their own (`syncHistoryButtons`, the read-only
   * lock), and a loop that wrote `disabled = false` for every ungated action
   * would light Redo up with an empty stack every time the reader changed tabs.
   *
   * Cached on the KIND, because `doc` fires on every keystroke in a cell and
   * nothing about a keystroke can change this answer.
   */
  let gatedFor: string | null = null
  const gateActions = (force = false): void => {
    const kind = shownKind()
    if (!force && kind === gatedFor) return
    gatedFor = kind
    for (const id of ACTION_IDS) {
      if (ACTIONS[id].on === 'workbook') continue
      const btn = app.querySelector<HTMLButtonElement>(`[data-act="${id}"]`)
      if (!btn) continue
      // the tooltip it was built with, kept so re-enabling can put it back
      if (btn.dataset.tip === undefined) btn.dataset.tip = btn.title
      const why = actionReason(id, kind)
      btn.disabled = !!why
      btn.title = why || (btn.dataset.tip ?? '')
    }
  }

  // --- THE BRIDGE between the two kinds -------------------------------------
  //
  // Six toolbar buttons are greyed on a spreadsheet, and every one of their
  // tooltips ends in the same sentence: charts, pivots, filters and SQL bind
  // typed COLUMNS. Without a way across, that sentence is a dead end rather
  // than an explanation — which is why docs/dash-sheet-kinds.md calls the
  // conversion, not the second kind, the actual product.
  //
  // The gesture is here; every DECISION is in promote.ts and rigged with no
  // DOM. What this code owns is the three things a pure function must not do:
  // ASK (the header row is offered, never assumed), COMMIT (one `setSheet`
  // patch, so one promotion is one press of ⌘Z), and SAY (the findings land in
  // the same banner an import's do — including the one that says the range was
  // copied and not moved).
  const bridgeBtn = app.querySelector<HTMLButtonElement>('.dx-bridge')!

  // Cached per document change, because the LABEL needs it: a spreadsheet cell
  // holding a formula stores no value, so without the computed map a block of
  // formulas reads as blank and `currentRegion` would stop at its edge.
  let cvValues: { id: string; values: ReadonlyMap<string, unknown> } | null = null
  const canvasView = (cv: CanvasSheet): CanvasView => {
    if (cvValues?.id !== cv.id) {
      // GUARDED ON THIS SHEET HAVING A FORMULA AT ALL, exactly as
      // `Grid.cvRefresh` is guarded, and for a sharper reason here: this runs
      // on every keystroke, and `workbookSources` scans a DATASET sheet rows ×
      // columns for its cell formulas. A workbook with a 100k-row dataset in it
      // would pay that scan to re-letter a label.
      const live = Object.keys(cv.cells).some((k) => isFormula(cv.cells[k]?.f))
      cvValues = !live ? { id: cv.id, values: new Map() } : {
        id: cv.id,
        values: recalcWorkbook(
          // The dataset on screen supplies its computed columns, so
          // `=Sales!C2` into a calculated column promotes as its number. The
          // other sheets' are a cache this build does not have — the same gap
          // `Grid.cvRefresh` documents, and the same one call site.
          workbookSources(store.doc, (tb) => (tb.id === grid.showingId() ? grid.computed : undefined)),
          store.doc.modified,
        ).get(cv.id)?.values ?? new Map(),
      }
    }
    return { cells: cv.cells, computed: cvValues.values }
  }

  /**
   * The range a promotion would take.
   *
   * A DRAGGED RANGE IS OBEYED; a single cell asks for the block it is standing
   * in (`currentRegion`), because clicking in a table and asking for the table
   * is the gesture people make and dragging over four hundred rows is not.
   */
  const bridgeBox = (cv: CanvasSheet): CellBox => {
    const b = normalize(grid.sel.active)
    if (b.top !== b.bottom || b.left !== b.right) return b
    return currentRegion(canvasView(cv), { row: b.top, col: b.left })
  }

  /** What the button says, which is different on each kind and hidden on the rest. */
  const syncBridge = (): void => {
    const sheet = shownSheet()
    if (sheet?.kind === 'canvas') {
      bridgeBtn.hidden = false
      bridgeBtn.textContent = t('Make {range} a dataset')
        .replace('{range}', describeBox(bridgeBox(sheet as CanvasSheet)))
      bridgeBtn.title = t('Infer a type for each column and add a dataset sheet. The spreadsheet keeps these cells — the dataset is a copy of them.')
      return
    }
    if (sheet?.kind === 'table') {
      bridgeBtn.hidden = false
      bridgeBtn.textContent = t('Open as a spreadsheet')
      bridgeBtn.title = t('A flat, cell-by-cell COPY, for the one calculation a column cannot express. The dataset stays the live one.')
      return
    }
    // A pivot or a view is derived from a dataset already; there is nothing for
    // this control to mean, so it goes rather than lying about being available.
    bridgeBtn.hidden = true
  }
  bridgeBtn.addEventListener('click', () => {
    const sheet = shownSheet()
    const r = bridgeBtn.getBoundingClientRect()
    if (sheet?.kind === 'canvas') openPromote(sheet as CanvasSheet, r.left, r.bottom + 6)
    else if (sheet?.kind === 'table') openFlatten(sheet, r.left, r.bottom + 6)
  })

  /** Add a sheet after the one it came from, in ONE patch: one promotion, one undo. */
  const addSheet = (after: string, sheet: Sheet, findings: PromoteFinding[]): void => {
    const at = store.doc.sheets.findIndex((s) => s.id === after) + 1
    store.commit({ op: 'setSheet', id: sheet.id, sheet, at })
    grid.setSheet(sheet.id)
    // WHAT COULD BE WRONG GOES FIRST. Every line in this banner looks the same,
    // and a promotion emits both kinds: "3 values could not be read as number"
    // needs a decision, "the range is still on the spreadsheet" is reassurance.
    // Printed in emission order the reassurance sits on top and the reader
    // stops there. Stable within each group, so the order promote.ts chose —
    // which is column order — survives.
    showFindings(findingsEl, [
      ...findings.filter((f) => f.severity === 'suspicious'),
      ...findings.filter((f) => f.severity !== 'suspicious'),
    ])
  }

  /**
   * The header question, in front of the reader with the answer already filled
   * in and the reasoning beside it.
   *
   * `detectHeader` is only sure when something CHANGES between the first row
   * and the rest, and a block that is text all the way down is exactly where a
   * silent guess names a column "12400" or eats a row of data. So the guess is
   * shown, it says why, and it is one click to disagree with.
   */
  function openPromote(cv: CanvasSheet, x: number, y: number): void {
    if (refuseWrite(findingsEl, store)) return
    const v = canvasView(cv)
    const box = bridgeBox(cv)
    const trimmed = trimBox(v, box) ?? box
    const guess = detectHeader(v, trimmed)
    const el = popover(x, y, [
      `<div style="padding:6px 10px;font-weight:600">${esc(t('Make {range} a dataset').replace('{range}', describeBox(trimmed)))}</div>`,
      `<label style="display:flex;gap:8px;align-items:flex-start;padding:4px 10px 8px;cursor:pointer">`,
      `<input type="checkbox" class="dx-hdr"${guess.header ? ' checked' : ''} style="margin-top:3px">`,
      `<span><span>${esc(t('The first row holds the column names'))}</span>`,
      `<span style="display:block;opacity:.7;font-size:11px;margin-top:2px">${esc(guess.why)}</span></span></label>`,
      `<div style="padding:0 10px 8px;opacity:.7;font-size:11px;max-width:260px">`,
      `${esc(t('The spreadsheet keeps these cells. Formulas pointing into the range still work, and the dataset is a copy taken now.'))}</div>`,
      `<button class="dx-go">${esc(t('Make dataset'))}</button>`,
    ].join(''))
    el.querySelector<HTMLElement>('.dx-go')!.onclick = () => {
      const header = el.querySelector<HTMLInputElement>('.dx-hdr')!.checked
      el.remove()
      const id = mintSheetId(store.doc)
      const r = promoteRange(v, box, {
        sheetId: id,
        name: mintSheetName(store.doc, t('{name} dataset').replace('{name}', cv.name)),
        header, from: cv.name, at: new Date().toISOString(),
      })
      // A REFUSAL IS A SENTENCE, never a silence and never a throw: an empty
      // selection and a one-row block read as a header both come back here.
      if (!r.ok) { showFindings(findingsEl, [{ message: r.message }, ...r.findings]); return }
      addSheet(cv.id, r.sheet, r.findings)
    }
  }

  /**
   * The other direction, and the reason the round trip is the product: a
   * dataset cannot express "one weird number in the corner", and reaching for
   * Excel to get it is how people stop using the tool that has their data.
   *
   * IT IS A COPY AND THE POPOVER SAYS SO BEFORE IT IS MADE, not only in the
   * findings afterwards. A link back that silently went stale would be worse
   * than a copy that is honest about being one — the same reasoning promotion
   * makes in the other direction.
   */
  function openFlatten(sheet: TableSheet, x: number, y: number): void {
    if (refuseWrite(findingsEl, store)) return
    const el = popover(x, y, [
      `<div style="padding:6px 10px;font-weight:600">${esc(t('Open "{name}" as a spreadsheet').replace('{name}', sheet.name))}</div>`,
      `<label style="display:flex;gap:8px;align-items:center;padding:4px 10px 8px;cursor:pointer">`,
      `<input type="checkbox" class="dx-hdr" checked>`,
      `<span>${esc(t('Write the column names into row 1'))}</span></label>`,
      `<div style="padding:0 10px 8px;opacity:.7;font-size:11px;max-width:260px">`,
      `${esc(t('A COPY, as the dataset is right now. Editing it does not change the dataset, and the dataset does not update it.'))}</div>`,
      `<button class="dx-go">${esc(t('Make spreadsheet copy'))}</button>`,
    ].join(''))
    el.querySelector<HTMLElement>('.dx-go')!.onclick = () => {
      const header = el.querySelector<HTMLInputElement>('.dx-hdr')!.checked
      el.remove()
      const id = mintSheetId(store.doc)
      const r = flattenToSpreadsheet(sheet, {
        sheetId: id,
        name: mintSheetName(store.doc, t('{name} copy').replace('{name}', sheet.name)),
        // A calculated column stores no values — without this the copy is a
        // column of blanks under a header that promises numbers.
        computed: sheet.id === grid.showingId() ? grid.computed : undefined,
        header,
      })
      addSheet(sheet.id, r.sheet, r.findings)
    }
  }

  // --- the formula bar and the status bar, both driven by the selection
  grid.onSelectionChange = (summary, ref, value) => {
    refEl.textContent = ref
    if (document.activeElement !== fxEl) fxEl.value = value
    sumEl.textContent = summary
    // The label names the RANGE, so it is wrong the moment the selection moves.
    syncBridge()
  }
  fxEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    grid.setActiveCell(fxEl.value)
    fxEl.blur()
  })

  // --- the filter and sort menu, hung off each column header's caret
  // What the status bar says about the VIEW. The grid owns the text, because
  // the grid owns the view, and it announces from every path that changes one —
  // a sort, a filter, a clear, a sheet switch. `showView()` used to have a
  // single caller inside the filter menu, so the line describing the view went
  // stale the moment the view changed by any other route: "4 of 8 rows" was
  // observed sitting under a different sheet entirely.
  grid.onViewChange = (text) => { viewEl.textContent = text }
  // BOTH DOORS, and deliberately in one change: the caret in the header and
  // the column menu's "Sort and filter…" are two ways to the same thing, and
  // this codebase has now been bitten three times by giving one door a feature
  // the other lacks (import findings, defined names, and this menu itself).
  grid.onFilterMenu = (colId, x, y) => openColumnMenu({ store, grid, colId, x, y })
  // ASSIGNED AT mountPanels, below. The context menu is wired before the panels
  // exist and its "More conditional formatting…" item has to reach them, so the
  // reference is late-bound rather than the wiring re-ordered — moving
  // mountPanels above this would break the chaining of grid.onSelectionChange
  // that the comment at its call site is about.
  let panels: Panels | null = null
  // ALL THREE MENUS, in one call. The cell menu, the row gutter's and the
  // column header's are wired inside gridmenu.ts so that the wiring itself is
  // reachable from `scripts/test-dash-menu.ts` — a menu that exists only in a
  // function nobody called is the shape both of the unreachable-feature
  // findings took.
  const menuHooks: MenuHooks = {
    askForm: (o) => askForm(o),
    notice: (msgs) => showFindings(findingsEl, msgs.map((message) => ({ message }))),
    toast: (m) => toast(m),
    copy: (cut) => doCopy(cut),
    paste: () => { void doPaste() },
    pasteSpecial: (px, py) => openPasteSpecial(px, py),
    split: () => { void textToColumns() },
    condFmt: () => panels?.reveal(t('Conditional formatting')),
    filterMenu: (colId, px, py) => openColumnMenu({ store, grid, colId, x: px, y: py }),
  }
  installGridMenus(store, grid, menuHooks)
  // What appending a row did to the formulas in it — finding 11. The grid says
  // it because only the grid knows; the strip shows it because that is where
  // every other sentence the document has to make lands, and a toast would be
  // gone before the reader looked up from the row they just typed.
  grid.onNotice = (msgs) => showFindings(findingsEl, msgs.map((message) => ({ message })))

  // keyboard: the grid owns the key set when nothing else has focus
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.isContentEditable)) return
    // A bare printable key REPLACES the selected cell — the most-used gesture
    // in a spreadsheet, and the one that makes a grid feel like one. It has to
    // be tried before keyToAction, which returns null for printable keys
    // precisely so that typing can reach here — EXCEPT for the handful the map
    // does claim. ⇧Space means select-the-row in every spreadsheet, and without
    // that `!keyToAction(e)` it typed a space into the cell instead.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && !keyToAction(e)) {
      if (grid.typeInto(e.key)) { e.preventDefault(); return }
    }
    // BEFORE `handleKey`, and that ordering is the whole of it: ⌘X clears the
    // selection, so a snapshot taken after the grid has run is a rectangle of
    // blanks. `rememberClip` only reads.
    const clipAct = keyToAction(e)
    if (clipAct && (clipAct.kind === 'copy' || clipAct.kind === 'cut')) {
      rememberClip(clipAct.kind === 'cut')
    }
    if (grid.handleKey(e)) e.preventDefault()
  })
  grid.onRetype = (col, x, y) => retype(store, col, x, y)
  // Double-clicking a computed cell. It can only arrive from the dataset grid —
  // a spreadsheet has no formula COLUMNS — but the sheet is looked up rather
  // than narrowed, so a repaint that lands between the double-click and this
  // callback cannot throw.
  grid.onEditFormula = (col) => {
    const sheet = dataset('formula')
    if (sheet) void editFormula(store, sheet, col)
  }

  // --- chart: the NUMBERS are derived at render and never stored; the CHOICE
  // of what to chart is document state (`doc.chart`, model.ts `OpenChart`).
  //
  // Both used to live in the two `let`s below and nowhere else, under a comment
  // saying "never stored". Deriving the numbers is right — a chart must never
  // be a stale copy of the sheet. But "these columns, on that sheet, as a pie"
  // is a choice somebody made, and it was lost on reload, on closing the tab,
  // and on saving the file and sending it: the reader opened a workbook with no
  // chart and nothing to say one had ever been drawn.
  //
  // The `let`s stay as the live copy — every redraw path already reads them —
  // and `rememberChart` mirrors each change into the document.
  const chartEl = app.querySelector<HTMLElement>('.dx-chart')!
  const chartBody = app.querySelector<HTMLElement>('.dx-chart-body')!
  const chartTitle = app.querySelector<HTMLElement>('.dx-chart-title')!
  const kindBtn = app.querySelector<HTMLElement>('.dx-chart-kind')!
  let binding: ChartBinding | null = null
  // The sheet the chart is ABOUT. A chart is an argument about one table —
  // `StoryStep` carries `sheet` beside `chart` for exactly this reason — so it
  // is PINNED here and never follows the tab bar. Reading `grid.sheet` instead
  // left the old chart painted beside the new grid on every sheet switch, and
  // the next edit redrew it as an empty axis against columns that had never
  // existed on the sheet in front of the reader.
  let chartSheetId: string | null = null
  let teardown: (() => void) | null = null
  const KINDS: Array<ChartBinding['kind']> = ['bar', 'line', 'pie', 'scatter']

  const chartSheet = (): TableSheet | null => {
    const s = store.doc.sheets.find((x) => x.id === chartSheetId)
    return s && s.kind === 'table' ? s : null
  }

  /**
   * Mirror the live chart choice into `doc.chart`, so it survives the file.
   *
   * THROUGH `setDocProps`, which is the existing doc-level patch and gives an
   * inverse for free — so ⌘Z takes back "I switched it to a pie", which is a
   * change to the document like any other now that it is IN the document.
   *
   * GUARDED AGAINST A NO-OP COMMIT. `drawChart` runs on every `doc` event, so
   * writing unconditionally from there would commit on its own commit forever.
   * Comparing the serialized shape is enough: the binding is four plain fields
   * and an id, and this is the one place the comparison is made.
   */
  const rememberChart = (): void => {
    if (store.readOnly) return
    const want = binding && chartSheetId && !chartEl.hidden
      ? { sheet: chartSheetId, binding }
      : null
    const have = store.doc.chart ?? null
    if (JSON.stringify(want) === JSON.stringify(have)) return
    store.commit(want
      ? { op: 'setDocProps', props: { chart: structuredClone(want) } }
      : { op: 'setDocProps', props: {}, drop: ['chart'] })
  }

  const drawChart = () => {
    if (!binding || chartEl.hidden) return
    teardown?.()
    const sheet = chartSheet()
    // The sheet it was about has been deleted. There is nothing left to be
    // truthful about, so the panel closes rather than keeping the last numbers
    // it happens to be holding on screen.
    if (!sheet) {
      teardown = null; binding = null; chartSheetId = null; chartEl.hidden = true
      // `drawChart` runs INSIDE the `doc` emit, and `rememberChart` commits —
      // re-entering the store from its own event. Deferred by a microtask so
      // the drop is an ordinary commit after this one finishes, which is also
      // what makes it a separate, undoable step rather than a rider on the
      // delete.
      queueMicrotask(rememberChart)
      return
    }
    // THE SHEET ON SCREEN, READ WITHOUT NARROWING. This was `grid.sheet`, and
    // `drawChart` runs on `doc`, on `view` and on every sheet change — so with a
    // chart open, switching to a SPREADSHEET tab threw out of the redraw, and
    // afterwards every keystroke on that sheet threw again. The chart is pinned
    // to its own sheet and only needs the shown one to say so.
    const shown = shownSheet()
    const shownId = shown?.id ?? ''
    chartTitle.textContent = chartHeading(sheet, binding, shownId)
    kindBtn.textContent = binding.kind[0].toUpperCase() + binding.kind.slice(1)
    teardown = renderChart(chartBody, sheet, binding,
      // the grid's freshly computed formula columns, so the chart shows the
      // numbers on screen rather than the raw columns underneath them — but
      // only while the grid is showing THIS sheet. `grid.computed` is keyed by
      // column id and belongs to `grid.sheet`; handing it to another sheet's
      // chart charts one sheet's formulas under another's column names.
      sheet.id === shownId
        ? (grid.computed as Map<string, unknown[]>)
        : (recalc(sheet, store.doc.modified).values as Map<string, unknown[]>),
      {
        // THE VIEW VECTOR — the same one the footer totals read in grid.ts. A
        // sort permutes it and every total is unchanged; a filter shortens it
        // and every total must follow, or the chart draws bars for rows the
        // reader cannot see (measured: £97,050 beside a £69,050 footer).
        rows: store.order[sheet.id] ?? null,
        showing: shown && shown.id !== sheet.id ? { id: shown.id, name: shown.name } : null,
        onRebind: () => {
          // "Chart this sheet instead" — and the sheet it would rebind to can be
          // a spreadsheet, which has no columns to bind. Same guard, same
          // sentence as the toolbar's tooltip.
          const to = dataset('chart')
          if (!to) return
          const next = defaultBinding(to)
          if (!next) {
            showFindings(findingsEl, [{ message: t('This sheet has no numeric column to chart yet.') }])
            return
          }
          binding = next
          chartSheetId = to.id
          rememberChart()
          drawChart()
        },
      })
  }
  /**
   * THE PANEL FOLLOWS THE DOCUMENT, not only the gestures in this file.
   *
   * `doc.chart` can change without anybody touching the chart controls: ⌘Z, a
   * redo, "Replace from JSON…", a restored version, or a collaborator's op.
   * Measured after the field first landed: closing the chart dropped it
   * correctly and ONE undo put `doc.chart` back — with the panel still shut. The
   * file said there was a chart and the screen said there was not, which is the
   * same two-readouts-disagreeing failure as the footer that ignored the filter,
   * one layer up.
   *
   * `viz` owns the panel when 3D is up, so this stands aside for it rather than
   * fighting it for the same element.
   */
  const syncChartPanel = (): void => {
    if (viz) return
    const want = store.doc.chart
    if (want && !binding) reopenStoredChart()
    else if (!want && binding) {
      teardown?.(); teardown = null
      binding = null; chartSheetId = null; chartEl.hidden = true
    } else drawChart()
  }
  store.on('doc', syncChartPanel)
  // FILTERING AND SORTING ARE VIEW STATE: `store.view()` emits `view` and never
  // `doc` (that is the point — they must not dirty the file). Listening only for
  // `doc` is why the chart ignored a filter completely: nothing redrew it.
  store.on('view', drawChart)
  kindBtn.addEventListener('click', () => {
    if (viz) {
      viz.kind = KINDS3D[(KINDS3D.indexOf(viz.kind) + 1) % KINDS3D.length]
      draw3d()
      return
    }
    if (!binding) return
    binding.kind = KINDS[(KINDS.indexOf(binding.kind) + 1) % KINDS.length]
    rememberChart()
    drawChart()
  })
  app.querySelector('.dx-chart-close')!.addEventListener('click', () => {
    chartEl.hidden = true
    // Closing the panel is closing the chart — the document should not keep a
    // chart the reader has just dismissed and would not see on reopening.
    binding = null; chartSheetId = null
    rememberChart()
    clearPivot()
    teardown?.(); teardown = null
    vizDown?.(); vizDown = null; viz = null; vizSheetId = null
  })
  app.querySelector('[data-act="chart"]')!.addEventListener('click', () => {
    const sheet = dataset('chart')
    if (!sheet) return
    clearPivot()
    vizDown?.(); vizDown = null; viz = null; vizSheetId = null
    binding = defaultBinding(sheet)
    chartSheetId = sheet.id
    if (!binding) { showFindings(findingsEl, [{ message: t('This sheet has no numeric column to chart yet.') }]); return }
    chartEl.hidden = false
    rememberChart()
    drawChart()
  })
  /**
   * REOPEN THE CHART THE FILE WAS SAVED WITH.
   *
   * Everything it needs is validated here rather than trusted, because the
   * field is additive and the workbook may have been round-tripped through a
   * build that has never heard of it: the sheet can have been deleted, or
   * turned into a spreadsheet, and the columns can have been removed or
   * renamed. Any of those and the panel simply does not open — an empty axis
   * against columns that no longer exist is the failure `chartHeading` and
   * `drawChart` were already written to avoid, arriving one step earlier.
   *
   * It does NOT call `rememberChart`: reopening is not a change, and committing
   * one would dirty a file the reader has only looked at.
   */
  const reopenStoredChart = (): void => {
    const stored = store.doc.chart
    if (!stored || typeof stored.sheet !== 'string' || !stored.binding) return
    const sheet = store.doc.sheets.find((x) => x.id === stored.sheet)
    if (!sheet || sheet.kind !== 'table') return
    const b = stored.binding
    if (!KINDS.includes(b.kind) || typeof b.x !== 'string' || !Array.isArray(b.series)) return
    if (missingColumns(sheet, b).length) return
    binding = { ...b, series: [...b.series] }
    chartSheetId = sheet.id
    chartEl.hidden = false
    drawChart()
  }
  reopenStoredChart()

  app.querySelector('[data-act="formula"]')!.addEventListener('click', () => {
    // THE SHEET IS CAPTURED HERE, not read again when the dialog closes. The
    // form is modal but the document is not frozen behind it: a remote op or a
    // restore can land while it is open, and re-reading afterwards would add
    // the column to whatever sheet is showing THEN rather than the one the
    // dialog named.
    const sheet = dataset('formula')
    if (sheet) void addFormula(store, sheet)
  })

  // --- 3D: the same panel, a different renderer. Geometry is derived from the
  // columns exactly as the 2D chart's series are, so nothing is stored.
  let viz: Viz3dBinding | null = null
  let vizDown: (() => void) | null = null
  // PINNED TO ITS OWN SHEET, exactly as the 2D chart is and for the same two
  // reasons. `draw3d` runs on `doc`, so reading `grid.sheet` threw the moment a
  // spreadsheet tab was open with a plot up — and before that it silently
  // rebuilt one sheet's geometry from another sheet's columns on every switch.
  let vizSheetId: string | null = null
  const KINDS3D: Viz3dKind[] = ['scatter', 'surface', 'bars', 'globe']
  const vizSheet = (): TableSheet | null => {
    const s = store.doc.sheets.find((x) => x.id === vizSheetId)
    return s && s.kind === 'table' ? s : null
  }
  const draw3d = () => {
    if (!viz || chartEl.hidden) return
    vizDown?.(); teardown?.(); teardown = null
    const sheet = vizSheet()
    // The sheet it was about has gone. Nothing left to be truthful about, so
    // the panel closes rather than holding the last geometry it happened to
    // build — the rule `drawChart` already follows.
    if (!sheet) { vizDown = null; viz = null; vizSheetId = null; chartEl.hidden = true; return }
    const shownId = grid.showingId()
    chartTitle.textContent = `3D ${viz.kind} · ` +
      [viz.x, viz.y, viz.z, viz.lat, viz.lon].filter(Boolean)
        .map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id).join(' / ') +
      // WHOSE numbers these are, whenever they are not the sheet on screen.
      (sheet.id === shownId ? '' : ` · ${sheet.name}`)
    kindBtn.textContent = viz.kind[0].toUpperCase() + viz.kind.slice(1)
    const scene = buildScene(sheet, viz, sheet.id === shownId
      ? (grid.computed as Map<string, unknown[]>)
      : (recalc(sheet, store.doc.modified).values as Map<string, unknown[]>))
    vizDown = mountViz3d(chartBody, scene)
  }
  store.on('doc', () => { if (viz) draw3d() })
  app.querySelector('[data-act="viz3d"]')!.addEventListener('click', () => {
    const sheet = dataset('viz3d')
    if (!sheet) return
    clearPivot()
    viz = defaultViz3d(sheet)
    if (!viz) {
      showFindings(findingsEl, [{ message: t('This sheet needs at least three numeric columns, or a latitude and longitude, to plot in 3D.') }])
      return
    }
    vizSheetId = sheet.id
    binding = null
    chartEl.hidden = false
    draw3d()
  })

  // Sheets on the left, properties on the right — the suite's shared chrome.
  // AFTER grid.onSelectionChange is set: mountPanels CHAINS that callback
  // rather than replacing it, so the formula bar and status bar keep working.
  panels = mountPanels({ store, grid, body: app.querySelector<HTMLElement>('.dx-body')! })


  // Comments. AFTER mountPanels, which chains grid.onSheetChange.
  const comments = mountComments({ store, grid, el: app.querySelector<HTMLElement>('.dx-grid')! })

  // A SHEET SWITCH IS NEITHER A `doc` NOR A `view` EVENT — `Grid.setSheet` just
  // repaints and calls this hook — so the chart heard nothing about one and kept
  // painting the sheet you had left. It stays pinned to its own sheet; it simply
  // has to redraw to say which sheet that is, and to offer to follow.
  // CHAINED, never assigned: mountPanels and mountComments are already on this
  // hook, and replacing it silently unhooks the sheet list and the comment
  // markers. (Registered last, so it runs after both.)
  // --- pivot. A pivot is a DOCUMENT, not a view: "revenue by region by
  // quarter" is an argument about what the data means, somebody built it, and
  // "look at the pivot on sheet 3" has to name something that exists in the
  // file. The sheet stores the SPEC and never the numbers.
  let pivotSpec: PivotSpec | null = null
  let pivotDown: (() => void) | null = null
  const drawPivot = (): void => {
    if (!pivotSpec || chartEl.hidden) return
    pivotDown?.(); teardown?.(); teardown = null
    const src = store.doc.sheets.find((sh) => sh.id === pivotSpec!.from)
    if (!src || src.kind !== 'table') return
    chartTitle.textContent = `${t('Pivot')} · ${src.name}`
    // A pivot has no chart KIND, so the Bar/Line toggle beside the title is a
    // control that does nothing to what is on screen. Hidden here and restored
    // by the chart path below.
    kindBtn.hidden = true
    // `grid.computed` IS KEYED BY COLUMN ID AND BELONGS TO THE SHOWN SHEET, so
    // handing it to a pivot pinned to another one summarises this sheet's
    // formulas under that sheet's column names — the mistake `drawChart` names
    // in its own comment. Off the source sheet (a spreadsheet tab included),
    // recompute the source's own values instead.
    const computed = src.id === grid.showingId()
      ? (grid.computed as Map<string, unknown[]>)
      : (recalc(src, store.doc.modified).values as Map<string, unknown[]>)
    pivotDown = mountPivot(chartBody, runPivot(src, pivotSpec, { computed }), { sheet: src, computed })
  }
  const clearPivot = (): void => {
    pivotDown?.(); pivotDown = null; pivotSpec = null
    kindBtn.hidden = false
  }
  store.on('doc', () => { if (pivotSpec) drawPivot() })

  // REGISTERED AFTER ALL THREE PANELS EXIST, and that is not tidiness: this
  // closure calls `drawPivot`, a `const` declared above, and a sheet switch
  // arriving between the two would be a temporal-dead-zone ReferenceError out of
  // boot — the same class of landmine `esc()` carries a paragraph about at the
  // foot of this file.
  const chartAfterSheetChange = grid.onSheetChange
  // ALL THREE PANELS, not just the 2D chart. Each early-returns unless it is
  // the one on screen, and each has something to correct on a switch: the chart
  // says whose sheet it is about, the 3D title now does too, and the pivot picks
  // between the grid's computed map and its own recalculation depending on
  // whether its source is still the sheet in front of the reader. Left off this
  // hook they corrected themselves only at the next keystroke.
  grid.onSheetChange = (id) => {
    chartAfterSheetChange?.(id)
    drawChart(); draw3d(); drawPivot()
    gateActions()
  }
  // AND ON `doc`, because a sheet switch is not the only way the kind under the
  // toolbar changes: About's restore, drop-open, recovery and a remote op all
  // replace the sheet list while the reader stands still. Cached on the kind, so
  // the common case — a keystroke in a cell — costs one string comparison.
  store.on('doc', () => gateActions())
  gateActions(true)
  // The bridge follows the same two events for the same reason, plus one of its
  // own: the computed map it reads is only true of the document that produced
  // it, so an edit anywhere invalidates it. Dropping the cache rather than
  // recomputing keeps a keystroke costing nothing — the next selection change
  // rebuilds it, and until then the label is not on screen to be wrong.
  store.on('doc', () => { cvValues = null; syncBridge() })
  syncBridge()


  app.querySelector('[data-act="import-xlsx"]')!.addEventListener('click', () => {
    void pickXlsx(store, findingsEl, grid)
  })
  app.querySelector('[data-act="export-xlsx"]')!.addEventListener('click', () => {
    // WORKBOOK-SCOPED: it writes every dataset in the file, so the sheet on
    // screen cannot make it unavailable. All it takes from the grid is the
    // computed map, and only when the sheet on screen is the one that map
    // belongs to — it used to reach for `grid.sheet.id` unconditionally and
    // reject the whole export with an unhandled rejection on a spreadsheet tab.
    const shown = shownSheet()
    void saveXlsx(store, findingsEl, shown && shown.kind === 'table'
      ? { id: shown.id, computed: grid.computed as Map<string, unknown[]> }
      : null)
  })

  app.querySelector('[data-act="pivot"]')!.addEventListener('click', () => {
    const from = dataset('pivot')
    if (!from) return
    const spec = defaultPivot(from)
    if (!spec) {
      showFindings(findingsEl, [{ message:
        t('This sheet needs a category column and a numeric column to pivot.') } as never])
      return
    }
    // A PATCH, not replaceDoc: creating a pivot used to clear the undo stack,
    // so every edit you could previously take back vanished the moment you
    // asked for a summary of them.
    const id = `pivot-${Math.floor(Date.now() % 1e8).toString(36)}`
    store.commit({
      op: 'setSheet', id,
      sheet: newPivotSheet(id, `${from.name} — ${t('pivot')}`, spec),
    } as never)
    binding = null; viz = null; vizDown?.(); vizDown = null; vizSheetId = null
    pivotSpec = spec
    chartEl.hidden = false
    drawPivot()
  })

  // --- the dashboard. The LAYOUT is document data (doc.views); the SELECTION
  // is viewer state and goes through store.view(), so a cross-filter click
  // never dirties the file.
  const dashEl = app.querySelector<HTMLElement>('.dx-dash')!
  const dash = new Dashboard({ el: dashEl, store })
  // a CALLBACK, not a snapshot: Grid.paint REPLACES grid.computed each paint
  dash.computed = () => grid.computed as Map<string, unknown[]>
  app.querySelector('[data-act="dashboard"]')!.addEventListener('click', () => {
    const show = dashEl.hidden
    dashEl.hidden = !show
    app.querySelector<HTMLElement>('.dx-grid')!.hidden = show
    if (show) dash.render()
  })

  // The hook: a workbook that presents itself. A step is a saved VIEW — filter,
  // sort, chart binding, camera, caption — and stepping between them morphs the
  // chart from the model, because both frames are already in the file.
  // A CAPTURE-PHASE GUARD IN FRONT OF story.ts's OWN LISTENER, because this is
  // the one action whose click handler is not in this file. The disabled button
  // stops a reader, and `stopImmediatePropagation` stops everything else: a
  // dispatched click, an automated one, a listener that runs before the bar has
  // been re-gated. Capture always beats bubble, so mount order does not matter.
  const storyBtn = app.querySelector<HTMLElement>('[data-act="story"]')!
  storyBtn.addEventListener('click', (e) => {
    if (!dataset('story')) e.stopImmediatePropagation()
  }, true)
  installStory({
    store,
    button: storyBtn,
    // `showingId()`, not `grid.sheet.id`. The Story button is disabled on a
    // sheet a step cannot describe, but these are read by the panel while it is
    // OPEN — and the reader can change tabs underneath it, which is a sheet
    // switch mid-gesture and used to throw out of Capture.
    sheetId: () => grid.showingId(),
    filters: () => grid.filters,
    sorts: () => grid.sorts,
    // A step pairs ONE sheet with ONE chart, so it may only capture the chart
    // when the chart is about the sheet being captured. The chart is pinned and
    // the story captures `grid.sheet`, so without this a step could store a
    // Pipeline chart against Sheet 2 and play back a pairing nobody ever saw.
    chart: () => (chartSheetId === grid.showingId() ? binding : null),
    viz: () => viz,
    computed: (id) => (id === grid.showingId() ? (grid.computed as Map<string, unknown[]>) : undefined),
  })

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
      if (!isEncryptionActive()) {
        // THE RETURN VALUE IS THE POINT, and it was being thrown away.
        //
        // `putRecovery` resolves FALSE rather than throwing when there is no
        // usable IndexedDB — Safari in private browsing, and some file://
        // contexts, which on iOS is exactly where a workbook someone was sent
        // tends to be opened. The kernel says so in its own header, in as many
        // words: "Claiming a backstop that isn't there would be worse than
        // saying nothing." dash claimed it anyway.
        //
        // Told ONCE per session, and only on the way down. A banner on every
        // debounced edit would be noise, and the fact does not change during a
        // session — but somebody editing for an hour on the assumption that a
        // crash costs them nothing deserves to know it costs them everything.
        void putRecovery(store.doc).then((stored) => {
          if (stored || warnedNoBackstop) return
          warnedNoBackstop = true
          toast(t('This browser will not keep a local backup of your work. Save the file yourself to keep changes.'))
        })
        // the timeline the About dialog restores from — throttled inside, and
        // it refuses an encrypted workbook for the same reason putRecovery does
        void rememberVersion(store.doc)
      }
      // …AND THE FILE ITSELF. Deliberately outside the `isEncryptionActive`
      // guard above: that guard is about writing PLAINTEXT into IndexedDB,
      // and this writes the workbook's own file through the encryption-aware
      // `serializeAuto`. See writeback.ts's header — two channels, two rules.
      void runWriteBack()
    }, 2500)
  }
  let warnedNoBackstop = false

  // --- write-back to the real file
  //
  // The single biggest data-loss risk dash shipped with: the IndexedDB
  // snapshot above was the ONLY thing catching an hour of typing, and it is
  // invisible, uncopyable and cleared by browsers on their own schedule.
  //
  // It rides the SAME debounce as the snapshot rather than owning a timer.
  // Two timers over one stream of edits means two serializations of a workbook
  // that can be tens of MB, and they would race for the one file handle.
  //
  // NO `stamp` DEP, deliberately. slides stamps `session.stampInto(doc)` into
  // every write-back so a copy edited offline rejoins as a fork (PLATFORM §5);
  // dash calls `stampInto` from nowhere at all — not even ⌘S. Wiring it here
  // and only here would make the automatic save write a DIFFERENT document
  // from the manual one, which is a worse bug than the one it fixes. Write-back
  // writes exactly what ⌘S writes. Stamping is dash's to add on both paths at
  // once; the dep exists in writeback.ts so that change is one line here.
  const writeBack = new FileWriteBack()
  let wbTag: HTMLElement | null = null
  async function runWriteBack(): Promise<void> {
    const { notice } = await writeBack.run(store.doc, store.readOnly)
    if (!notice) return
    if (notice.say === 'failed') {
      // INTERRUPTS, unlike a success. The file on disk is now older than the
      // screen and the author has no other way to find that out — the unsaved
      // dot cannot distinguish "not written yet" from "cannot be written".
      dirty = true
      dirtyEl.hidden = false
      dirtyEl.title = t('The last automatic save to the file failed. Press ⌘S.')
      toast(t('Could not save to the file automatically — {why}. Your changes are still here; press ⌘S.')
        .replace('{why}', notice.why))
      return
    }
    // The bytes are on disk. Clearing the dot here is the whole point: it is
    // the same claim ⌘S makes, and it is now true without one.
    dirty = false
    dirtyEl.hidden = true
    dirtyEl.title = ''
    if (notice.say === 'recovered') toast(t('Saved to the file — automatic saving is working again.'))
    wbTag ??= app.querySelector<HTMLElement>('.dx-wb')
    if (!wbTag) return
    wbTag.textContent = t('Saved')
    wbTag.hidden = false
    clearTimeout(wbTimer)
    wbTimer = window.setTimeout(() => { if (wbTag) wbTag.hidden = true }, 1800)
  }
  let wbTimer: number | undefined
  // --- live collaboration.
  //
  // The session is CONSTRUCTED for every workbook but connects to nothing
  // unless the file arrived carrying credentials or the reader opts in this
  // session (`shareEligible`) — a freshly created workbook must never phone
  // home (PLATFORM §5).
  //
  // The rid block is set FIRST and before any edit can happen. Two replicas
  // minting the same rid for different rows would merge them into one and lose
  // a row, and rid is identity everywhere — the CRDT node key, overrides,
  // comments. See model.ts's partitioning note.
  const sync = new SyncSession(store)
  setRidBlock(ridBase(ridBlockFor(sync.actor)))
  ;(window as unknown as Record<string, unknown>).__sync = sync

  store.on('doc', markDirty)

  // The wordmark and the version chip open About. Mounted AFTER markDirty
  // exists — it takes it as the dirty signal for the edits it makes itself.
  const aboutHooks = {
    store,
    // KIND-AGNOSTIC. `planReplace` is asked "which sheet is the reader on, so
    // the new workbook can keep them there" — and on a spreadsheet the narrowing
    // accessor answered that question by throwing, out of About's own restore.
    showingSheet: () => grid.showingId(),
    showSheet: (id: string) => grid.setSheet(id),
    onDirty: markDirty,
    // so Offline mode can HANG UP an open relay socket, not merely refuse the
    // next connection — a switch that leaves the current one running is not one
    sync,
  }
  // The People panel: who else is in this workbook.
  //
  // It takes OVER its host (`host.innerHTML = …` on every render), so it gets
  // a container of its own. Handing it `app` erased the entire application on
  // boot — grid, panels, everything — and left only the panel markup behind,
  // with nothing in the console because nothing threw.
  const peopleEl = document.createElement('div')
  // INSIDE the right-hand group, not after it. The bar's end group is what the
  // responsive ladder measures and collapses; anything appended after it sits
  // outside that arithmetic and pushes the whole toolbar — Save included —
  // straight off the screen again.
  const barEnd = app.querySelector<HTMLElement>('.dx-bar-end') ?? app.querySelector<HTMLElement>('.dx-bar')!
  barEnd.insertBefore(peopleEl, barEnd.firstChild)
  mountPeople(peopleEl, sync, store)
  mountAbout(app, aboutHooks)
  // PLATFORM §6: the signed update check, once, at launch. It badges ⓘ rather
  // than interrupting. `shouldCheckAtLaunch` gates it on a SAVED workbook, the
  // check not opted out, and Offline mode off.
  checkAtLaunch({ saved })
  // …and an EXPLICIT way in. mountAbout only arms the wordmark and the version
  // chip, and nobody guesses that a logo is a button — the chip, meanwhile, is
  // the first thing the responsive rules drop. The ⓘ button is the real door;
  // the other two stay as shortcuts for whoever already found them.
  app.querySelector('[data-act="about"]')!.addEventListener('click', () => openAbout(aboutHooks))
  // The keyboard, made findable: a ? button beside About, and the ? key. The
  // card is GENERATED from select.ts's key map, so a binding added there shows
  // up here with no edit.
  mountHelp(app)
  void pruneOld()

  // --- the READ half of autosave, and opening a file by dropping it ---------
  //
  // Recovery was WRITE-ONLY: `putRecovery` ran on every debounced edit and
  // nothing ever read a snapshot back, so a crash lost work that was sitting
  // in IndexedDB the whole time.
  //
  // And nothing intercepted a file drop, so dropping anything on the window
  // hit the browser default and NAVIGATED AWAY from the workbook — taking
  // unsaved edits with it. That, not convenience, is why dropopen exists.
  //
  // Both go through the same swap: `Grid.sheet` throws when the sheet id it
  // holds is missing and it reads that from the FIRST `doc` listener, so a
  // workbook with different sheet ids takes the chart and the dirty flag down
  // with it. about.ts's `planReplace` is the fix, and it is shared, not copied.
  const openHost = {
    store,
    // KIND-AGNOSTIC. `planReplace` is asked "which sheet is the reader on, so
    // the new workbook can keep them there" — and on a spreadsheet the narrowing
    // accessor answered that question by throwing, out of About's own restore.
    showingSheet: () => grid.showingId(),
    showSheet: (id: string) => grid.setSheet(id),
    afterSwap: (next: DashDoc) => {
      // the chrome nothing else refreshes: the title field is written once at
      // boot and thereafter only by its own input handler
      titleEl.value = next.title
      document.title = `${next.title} — ${appConfig().appName}`
    },
  }
  void mountRecovery(openHost)
  mountDropOpen({
    ...openHost,
    importText: (text: string, source: string) => applyImport(store, findingsEl, grid, text, source),
    notice: (message: string | ReadonlyArray<{ message: string }>) =>
      showFindings(findingsEl, (typeof message === 'string' ? [{ message }] : message) as never),
    dirty: () => dirty,
  })

  titleEl.addEventListener('input', () => {
    store.commit({ op: 'setTitle', title: titleEl.value })
    document.title = `${titleEl.value} — ${appConfig().appName}`
  })

  // --- the top-bar dropdowns.
  // Two rules, and they are the whole of it: a trigger toggles its own group,
  // and ANY click outside shuts every group. The second rule has to be
  // pointerdown on the document — a menu that survives the click that opened
  // the next one leaves two panels overlapping, which is how a bar with one
  // menu is fine and a bar with two is not.
  //
  // Note the menus are NOT rebuilt per width: at wide widths CSS gives the
  // group `display: contents` and its buttons sit in the bar, so `.open` is
  // simply inert. Nothing moves, so nothing loses a listener.
  const shutMenus = (except?: Element) => {
    for (const dd of app.querySelectorAll('.dx-dd.open')) if (dd !== except) dd.classList.remove('open')
  }
  for (const trig of app.querySelectorAll<HTMLElement>('.dx-dd-trig')) {
    trig.addEventListener('click', (e) => {
      e.stopPropagation()
      const dd = trig.closest('.dx-dd')!
      const opening = !dd.classList.contains('open')
      shutMenus()
      dd.classList.toggle('open', opening)
    })
  }
  // a menu item is a command: run it and get out of the way
  for (const item of app.querySelectorAll('.dx-menu .dx-btn')) {
    item.addEventListener('click', () => shutMenus())
  }
  document.addEventListener('pointerdown', (e) => {
    const dd = (e.target as HTMLElement | null)?.closest?.('.dx-dd')
    shutMenus(dd ?? undefined)
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shutMenus() })

  // --- actions
  app.querySelector('[data-act="save"]')!.addEventListener('click', () => { void doSave() })
  installSaveMenu({
    button: app.querySelector<HTMLElement>('[data-act="save"]')!,
    store,
    save: doSave,
  })
  const undoBtn = app.querySelector<HTMLButtonElement>('[data-act="undo"]')!
  const redoBtn = app.querySelector<HTMLButtonElement>('[data-act="redo"]')!
  undoBtn.addEventListener('click', () => { store.undo() })
  redoBtn.addEventListener('click', () => { store.redo() })
  // A button that is always lit and sometimes does nothing teaches people that
  // the toolbar is decorative. Redo in particular is empty most of the time.
  //
  // ON A MICROTASK, and it has to be. `Store.undo` reads
  //
  //     this.redoStack.push(this.invert(e))
  //
  // and `invert` is what applies the patches and emits `doc` — so the emit
  // happens while the argument is still being evaluated, BEFORE the push. A
  // listener that reads `canRedo` synchronously sees the stack as it was a
  // moment ago and leaves Redo greyed out immediately after an undo, which is
  // the one instant it is certainly available. Measured exactly that before
  // this hop. Reading a beat later reads the truth, and unlike reordering the
  // store's emit it cannot disturb the collab session that listens to the same
  // event.
  const syncHistoryButtons = (): void => {
    undoBtn.disabled = store.readOnly || !store.canUndo
    redoBtn.disabled = store.readOnly || !store.canRedo
  }
  store.on('doc', () => queueMicrotask(syncHistoryButtons))
  syncHistoryButtons()
  app.querySelector('[data-act="export"]')!.addEventListener('click', () => {
    const sheet = dataset('export')
    if (sheet) exportCsv(store, sheet)
  })
  // PRINT. `shown` hands over the grid's computed columns for the sheet on
  // screen and nothing else — a formula column is derived, and recalculating it
  // a second time behind the grid is how the paper and the screen start to
  // disagree. The dialog reads `store.order` itself, which is the view vector
  // the footer, the chart, Find and the status bar all read.
  const printHost = {
    store,
    shown: () => {
      const s = shownSheet()
      if (!s) return null
      return s.kind === 'table'
        ? { id: s.id, computed: grid.computed }
        : { id: s.id }
    },
  }
  app.querySelector('[data-act="print"]')!.addEventListener('click', () => openPrintDialog(printHost))
  // ⌘P, and the browser's own print with it: every route to a printer now
  // builds the real printout rather than a page of application chrome.
  installPrint(printHost)
  app.querySelector('[data-act="import"]')!.addEventListener('click', () => {
    void pickCsv(store, findingsEl, grid)
  })
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === 's') { e.preventDefault(); void doSave() }
    // ⌘Z AND ⌘⇧Z ARE NOT HANDLED HERE, and removing them from this listener is
    // a fix, not a tidy-up. The grid's own document listener (above) already
    // routes them through `keyToAction` → `Grid.handleKey` → `store.undo`, and
    // `preventDefault` does not stop propagation — so every ⌘Z ran BOTH and
    // undid TWO steps. Found while checking that one promotion is one undo:
    // pressing ⌘Z after it removed the new sheet AND the edit before it.
    // The grid's path is the right one to keep: it is the single key map
    // (select.ts) and it stands down inside a text input, so ⌘Z in the title
    // field is the browser's own text undo again rather than a document undo.
    // ⌘D / ⌘Enter fill down. THE MAP decides which keys mean fill; a fill
    // WRITES CELLS, which the selection model cannot do, so the verb lands here.
    else if (keyToAction(e)?.kind === 'fill') { e.preventDefault(); grid.fillDownSelection() }
    // ⌘⇧V / ⌘⌃V and ⌘⇧D. Beside `fill` for the reason `fill` is here: the
    // browser hands this file no `paste` event for a chord that is not its own,
    // and both of these WRITE CELLS.
    else if (keyToAction(e)?.kind === 'pasteSpecial') { e.preventDefault(); openPasteSpecial() }
    else if (keyToAction(e)?.kind === 'textToColumns') { e.preventDefault(); void textToColumns() }
    else {
      // ⌘B / ⌘I / ⌘U. Beside `fill` and for the same reason: `Grid.handleKey`
      // routes motion and clipboard, and a style write is neither — it is a
      // patch cellfmt.ts builds from the selection.
      const a = keyToAction(e)
      if (a?.kind === 'style') {
        // Not while a field or a cell editor has the caret: ⌘B in the title
        // box is the browser's business, and the grid's own key handler stands
        // down there for exactly this reason.
        const el = e.target as HTMLElement | null
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
        e.preventDefault()
        styleSelection(a.field)
      }
    }
  })

  /**
   * ⌘B / ⌘I / ⌘U over the selection, on EITHER kind of sheet.
   *
   * ONE PATCH, so it is ONE undo step however many cells are selected — the
   * rule cellprops.ts and cellfmt.ts both hold and both rigs pin. The two arms
   * differ only in how a selection becomes keys: A1 addresses on a spreadsheet,
   * `<colId>:<rid>` on a dataset, which is the whole difference between the
   * kinds showing through at the one place it has to.
   *
   * The toggle is decided from the CELLS, not from the cursor: every cell on →
   * turn it off, anything else → turn it all on (cellfmt.ts `toggleTarget`).
   */
  function styleSelection(field: AppearanceField): void {
    if (store.readOnly) return
    const ranges = grid.sel.ranges() as CellRange[]
    const canvas = grid.canvas
    if (canvas) {
      const keys = rangeKeys(ranges)
      if (!keys.length) return
      const p = stylePatch(canvas, keys, {
        [field]: toggleTarget(keys.map((k) => canvas.cells[k]), field) ? true : null,
      })
      if (p) store.commit(p)
      return
    }
    let sheet: TableSheet
    try { sheet = grid.sheet } catch { return }
    const hidden = hiddenSet(sheet)
    const visible = sheet.columns.filter((c) => !hidden.has(c.id))
    const keys = overrideKeys(sheet, store.order[sheet.id], visible, ranges)
    if (!keys.length) return
    const p = appearancePatch(sheet, keys, {
      [field]: toggleTarget(keys.map((k) => sheet.cells?.[k]), field) ? true : null,
    })
    if (p) store.commit(p)
  }

  // --- Paste Special, and Text to Columns -----------------------------------
  //
  // Both live here, beside `fill` and `styleSelection`, for exactly the reason
  // those two do: they WRITE CELLS, which the selection model cannot do, and
  // `Grid.handleKey` routes motion and the clipboard and neither of these is
  // motion. Every DECISION either command makes is in pastespecial.ts and
  // tocolumns.ts, with no DOM and a rig each; what is left here is the gesture
  // — read the selection, ask the question, commit the patches, say what
  // happened.
  //
  // WHY THIS FILE REMEMBERS THE CLIP AND THE GRID'S OWN COPY IS NOT REUSED.
  // The grid keeps a private clip for ⌘V, and it holds values and formulas but
  // not appearance, which "formats only" is entirely about. More to the point
  // the browser delivers a `paste` EVENT only for its own paste chord: ⌘⇧V
  // never produces one, so a second chord has to read a clip this app kept.
  // So the snapshot is taken here, on the same keystroke, BEFORE the grid sees
  // it — ⌘X clears the selection, and a snapshot taken afterwards would be a
  // rectangle of blanks.

  /** Canonical row index of a rid — grid.ts's private `dataRow`, DOM-free. */
  const rowOfRid = (s: TableSheet, rid: number): number => {
    let i = 0
    for (const [start, count] of s.rids) {
      if (rid >= start && rid < start + count) return i + (rid - start)
      i += count
    }
    return -1
  }

  const shownCols = (s: TableSheet): Column[] => {
    const hidden = hiddenSet(s)
    return s.columns.filter((c) => !hidden.has(c.id))
  }

  /** What ⌘C / ⌘X last took: value, formula and appearance, per cell. */
  let clip: Clip | null = null

  /**
   * Snapshot the selection.
   *
   * `v` IS THE COMPUTED VALUE, deliberately, and that is the opposite of what
   * `fillCells` reads. A fill copies a formula DOWN, so seeding it from the
   * result destroys the formula (scripts/test-dash-fill.ts); "paste values
   * only" asks for the result on purpose. Both are held here at once: `f` is
   * the source and `v` is what it printed, so no mode has to reconstruct
   * either. What neither may do is store an ERROR, and `refusesValue` is the
   * gate the plan runs every value through.
   */
  function rememberClip(cut: boolean): void {
    const b = grid.sel.bounds()
    const cv = grid.canvas
    if (cv) {
      const view = canvasView(cv)
      const rows: ClipCell[][] = []
      for (let r = b.top; r <= b.bottom; r++) {
        const line: ClipCell[] = []
        for (let c = b.left; c <= b.right; c++) {
          const key = canvasKey(r, c)
          const cell = cv.cells[key]
          const fv = view.computed?.get(cellKey(r, c))
          const look = pickLook(cell as Record<string, unknown> | undefined)
          line.push({
            r, c,
            v: fv !== undefined ? fv : cell && 'v' in cell ? cell.v : null,
            ...(isFormula(cell?.f) ? { f: cell!.f } : {}),
            ...(look ? { look } : {}),
          })
        }
        rows.push(line)
      }
      clip = { kind: 'canvas', rows, ...(cut ? { cut: true } : {}) }
      return
    }
    let s: TableSheet
    try { s = grid.sheet } catch { return }
    const vis = shownCols(s)
    const order = store.order[s.id]
    // GUARDED ON THE SHEET HAVING A CELL FORMULA AT ALL, the same guard
    // `canvasView` makes and for the same reason: `workbookSources` walks a
    // dataset rows × columns, and a 100k-row sheet must not pay that to copy
    // four cells.
    const live = !!s.cells && Object.keys(s.cells).some((k) => isFormula(s.cells![k]?.f))
    const results = live
      ? recalcWorkbook(
        workbookSources(store.doc, (tb) => (tb.id === grid.showingId() ? grid.computed : undefined)),
        store.doc.modified,
      ).get(s.id)?.values ?? new Map<string, unknown>()
      : new Map<string, unknown>()
    const rows: ClipCell[][] = []
    for (let r = b.top; r <= b.bottom; r++) {
      const line: ClipCell[] = []
      const rid = ridAt(s, order, r)
      const dr = rid < 0 ? -1 : rowOfRid(s, rid)
      for (let c = b.left; c <= b.right; c++) {
        const col = vis[c]
        if (!col || dr < 0) { line.push({ r: dr, c, v: null }); continue }
        const ci = s.columns.findIndex((x) => x.id === col.id)
        const over = s.cells?.[`${col.id}:${rid}`]
        const f = typeof over?.f === 'string' && over.f !== '' ? over.f : undefined
        const fv = f === undefined ? undefined : results.get(cellKey(dr, ci))
        const comp = grid.computed.get(col.id)
        const v = fv !== undefined ? fv
          : over && 'v' in over ? over.v
            : comp ? comp[dr] : readCell(s.data[col.id], dr)
        const look = pickLook(over as Record<string, unknown> | undefined)
        line.push({ r: dr, c: ci, v, ...(f !== undefined ? { f } : {}), ...(look ? { look } : {}) })
      }
      rows.push(line)
    }
    clip = { kind: 'table', rows, ...(cut ? { cut: true } : {}) }
  }

  /**
   * Copy and Cut FROM A MENU — the same two steps the ⌘C keydown takes, in the
   * same order, because they are the same command reached with a mouse.
   *
   * `rememberClip` FIRST, and that ordering is the whole of it: a cut clears
   * the selection, so a snapshot taken after the grid has run is a rectangle of
   * blanks. That is why the keydown handler above calls it before `handleKey`,
   * and why this function exists rather than the menu calling `grid` directly.
   */
  function doCopy(cut: boolean): void {
    rememberClip(cut)
    grid.copyToClipboard(cut)
  }

  /**
   * Paste FROM A MENU.
   *
   * ⌘V never reaches this: the browser delivers a `paste` EVENT carrying the
   * data, and the listener below handles it. A menu item has no such event, so
   * it has to ASK for the clipboard — and `readText()` is permission-gated and
   * is refused outright in some embeddings. So there are two answers and the
   * reader gets whichever is true:
   *
   *   • the system clipboard, when the browser hands it over. Same text, same
   *     `pasteTsv`, same result as ⌘V.
   *   • dash's OWN last copy, when it does not. That is the clip Paste Special
   *     already pastes from, so a refused permission costs formulas-and-formats
   *     fidelity nothing; what it costs is content copied from ANOTHER
   *     application, which dash never saw.
   *
   * And when neither exists it says so, rather than looking broken.
   */
  async function doPaste(): Promise<void> {
    if (store.readOnly) return
    let text: string | null = null
    try {
      text = (await navigator.clipboard?.readText()) ?? null
    } catch {
      text = null                              // denied, or no clipboard at all
    }
    if (text) { grid.pasteTsv(text); return }
    if (clip) { runPasteSpecial('all', false); return }
    showFindings(findingsEl, [{
      message: t('There is nothing to paste. This browser will not hand a menu the system clipboard, so ⌘V pastes what a menu cannot reach.'),
    }])
  }

  /**
   * The menu's English, as LITERALS inside t().
   *
   * pastespecial.ts returns ids and refusal CODES and no prose, because the
   * i18n sweep reads t()'s argument out of the source: a sentence reached
   * through a variable is invisible to it and ships untranslated in all seven
   * locales. So the words live at the call site, where the extractor can see
   * them, and the pure module keeps the decision.
   */
  const pasteLabel = (i: PasteSpecialItem): string =>
    i.id === 'values' ? t('Values only')
      : i.id === 'formulas' ? t('Formulas')
        : i.id === 'formats' ? t('Formats only')
          : i.id === 'transpose' ? t('Transpose')
            : t('Values only, transposed')

  const refusalText = (why: PasteRefusal | undefined): string =>
    why === 'transpose-typed-columns'
      ? t('A dataset’s columns each have one type, so a transposed row of mixed types could only land as text. Transpose works on a spreadsheet sheet; on a dataset, use Pivot or Unpivot.')
      : ''

  /** The menu. What is available on this kind of sheet is pastespecial.ts's answer. */
  function openPasteSpecial(x?: number, y?: number): void {
    if (store.readOnly) return
    if (!clip) {
      showFindings(findingsEl, [{
        message: t('Copy something first — paste special pastes what dash last copied.'),
      }])
      return
    }
    const items = pasteSpecialItems(grid.isCanvas ? 'canvas' : 'table')
    const cur = grid.sel.cursor
    const anchor = document.querySelector<HTMLElement>(
      `.dg-row[data-row="${cur.row}"] .dg-cell[data-ci="${cur.col}"]`)
    const box = anchor?.getBoundingClientRect()
    const el = popover(x ?? box?.right ?? 120, y ?? box?.bottom ?? 120, items.map((i) =>
      `<button data-a="${i.id}"${i.enabled ? '' : ` disabled title="${esc(refusalText(i.why))}"`}>` +
      `${esc(pasteLabel(i))}</button>`).join(''))
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        const item = items.find((i) => i.id === b.dataset.a)
        el.remove()
        if (!item) return
        // A DISABLED ITEM STILL EXPLAINS ITSELF. Removing the row would leave
        // the reader hunting for a command that is simply not possible here;
        // greying it and saying why is the same choice tabs.ts makes for the
        // toolbar (`actionReason`).
        if (!item.enabled) {
          showFindings(findingsEl, [{ message: refusalText(item.why) }])
          return
        }
        runPasteSpecial(item.what, item.transpose)
      }
    })
  }

  function runPasteSpecial(what: PasteWhat, transpose: boolean): void {
    if (!clip || store.readOnly) return
    const plan = planPasteSpecial(clip, { what, transpose })
    if (plan.refusal) {
      showFindings(findingsEl, [{ message: refusalText(plan.refusal) }])
      return
    }
    const cur = grid.sel.cursor
    const cv = grid.canvas
    const notes: Notice[] = []
    let patches: Patch[]
    if (cv) {
      patches = canvasPastePatches({
        sheetId: cv.id,
        cellAt: (r, c) => cv.cells[canvasKey(r, c)],
        maxRows: CANVAS_MAX_ROWS,
        maxCols: CANVAS_MAX_COLS,
      }, cur.row, cur.col, plan)
    } else {
      let s: TableSheet
      try { s = grid.sheet } catch { return }
      const vis = shownCols(s)
      const order = store.order[s.id]
      const w = tablePastePatches({
        sheetId: s.id,
        colAt: (dc) => {
          const c = vis[cur.col + dc]
          return c
            ? {
              id: c.id, type: c.type, formula: c.formula, parsed: c.parsed,
              index: s.columns.findIndex((x) => x.id === c.id),
            }
            : null
        },
        ridAt: (dr) => ridAt(s, order, cur.row + dr),
        rowOf: (rid) => rowOfRid(s, rid),
        overrideAt: (k) => s.cells?.[k],
      }, plan)
      patches = w.patches
      if (w.skipped) {
        notes.push({
          message: t('{n} cell(s) had nowhere to land and were not pasted.')
            .replace('{n}', String(w.skipped)),
        })
      }
    }
    if (!patches.length) {
      showFindings(findingsEl, notes.length ? notes : [{ message: t('Nothing was pasted.') }])
      return
    }
    // ONE commit, so one ⌘Z puts the whole paste back.
    store.commit(patches)
    if (plan.dropped) {
      notes.unshift({
        message: t('{n} cell(s) held an error, not a value, and pasted blank.')
          .replace('{n}', String(plan.dropped)),
      })
    }
    if (notes.length) showFindings(findingsEl, notes)
  }

  /**
   * Text to Columns.
   *
   * ONE COLUMN AT A TIME, which is Excel's rule and is not arbitrary: the
   * output width is read from the data, so two source columns would spill into
   * each other by a distance neither of them chose.
   *
   * On a DATASET the whole column is split, not the selected rows — a column is
   * a column, and half a split column would be a column with two meanings in
   * it. On a SPREADSHEET the selection IS the extent, because there is no
   * column to mean anything.
   */
  async function textToColumns(): Promise<void> {
    if (store.readOnly) return
    const b = grid.sel.bounds()
    if (b.left !== b.right) {
      showFindings(findingsEl, [{
        message: t('Text to Columns splits one column. Select cells in a single column.'),
      }])
      return
    }
    const cv = grid.canvas
    let sheet: TableSheet | null = null
    let col: Column | undefined
    if (!cv) {
      try { sheet = grid.sheet } catch { return }
      col = shownCols(sheet)[b.left]
      if (!col) return
      if (col.formula) {
        showFindings(findingsEl, [{
          message: t('A computed column is defined by its formula; there is nothing stored in it to split.'),
        }])
        return
      }
    }
    const got = await askForm({
      title: t('Split into columns'),
      fields: [
        { key: 'by', label: t('Split on'), value: ',', mono: true, placeholder: t('e.g. , or ; or a space') },
        { key: 'widths', label: t('…or cut at character positions'), value: '', mono: true, placeholder: t('e.g. 3, 8, 12') },
      ],
      hint: cv
        ? t('Quoted fields stay whole. The first field replaces the cell you split; the rest spill to the right.')
        : t('Quoted fields stay whole. The whole column is split, and the column you split is kept.'),
      submit: t('Split'),
      check: (v) => (v.by === '' && v.widths.trim() === ''
        ? t('Give a delimiter, or the character positions to cut at.')
        : null),
    })
    if (!got) return
    const widths = got.widths.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    const spec: SplitSpec = widths.length ? { widths } : { by: got.by }

    if (cv) {
      const out = planCanvasSplit(cv, { top: b.top, bottom: b.bottom, col: b.left }, spec, canvasKey)
      if (out.refusal || !out.patches.length) {
        showFindings(findingsEl, [{ message: t('Nothing was split.') }])
        return
      }
      // EXCEL WARNS, AND SO DOES THIS. A split's width comes out of the data,
      // so the author cannot see how far right it will reach before it goes.
      if (out.overwrites && !window.confirm(
        t('This split writes over {n} cell(s) that already hold something. Replace them?')
          .replace('{n}', String(out.overwrites)))) return
      store.commit(out.patches)
      if (out.findings.length) showFindings(findingsEl, out.findings.map((f) => ({ message: f.message })))
      return
    }
    if (!sheet || !col) return
    const out = planTableSplit(sheet, col.id, spec)
    if (out.refusal || !out.patches.length) {
      showFindings(findingsEl, [{ message: t('Nothing was split.') }])
      return
    }
    if (out.collisions.length && !window.confirm(
      t('This split writes over the existing columns {cols}. Replace them?')
        .replace('{cols}', out.collisions.join(', ')))) return
    store.commit(out.patches)
    showFindings(findingsEl, [
      {
        message: t('“{col}” split into {n} new column(s).')
          .replace('{col}', col.name)
          .replace('{n}', String(out.into.length)),
      },
      ...out.findings.map((f) => ({ message: f.message })),
    ])
  }

  document.addEventListener('paste', (e) => {
    if ((e.target as HTMLElement)?.isContentEditable) return
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'INPUT') return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    e.preventDefault()
    // INTO THE CELLS, at the cursor — the gesture every spreadsheet has.
    // This used to route every pasted block into the CSV importer, so ⌘V
    // created a whole new sheet instead of filling the selection, and
    // `grid.pasteTsv` sat there with no callers at all. Importing a file is
    // what the Import button is for; ⌘V is paste.
    grid.pasteTsv(text)
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
    // EVERY OUTCOME SAYS SOMETHING, and two of them used to say nothing at all.
    //
    // `saveFile` has four results and can also throw, and this handled two of
    // them. `saved-as` — the FIRST save of a new workbook, the most common save
    // anyone ever performs — fell through the check, so the file was written
    // and the unsaved dot stayed lit, telling the author their work was not
    // saved when it was.
    //
    // The silence was worse than the dot. On a browser with no File System
    // Access API (Firefox, Safari, iOS) a save is a DOWNLOAD: a fresh copy
    // lands in Downloads and the file the author has open is left stale. Same
    // keystroke, same dot going out, completely different outcome — and nothing
    // on screen distinguished them. That is how someone keeps editing a file
    // that is no longer the one their work is in.
    //
    // A throw was invisible too: an unhandled rejection in the console of an
    // app the user is not looking at the console of. A revoked permission, a
    // deleted file and a full disk all arrive this way.
    let r: Awaited<ReturnType<typeof saveFile>>
    try {
      r = await saveFile(store.doc)
    } catch (err) {
      toast(t('Save failed — {why}').replace('{why}', err instanceof Error ? err.message : String(err)))
      return
    }
    if (r === 'cancelled') return          // they closed the picker; they know
    dirty = false
    dirtyEl.hidden = true
    dirtyEl.title = ''
    // These bytes ARE the file now, so write-back must not immediately rewrite
    // them — and a manual save that succeeded through the same handle clears
    // any standing "automatic saving failed" warning, which would otherwise sit
    // there contradicting the toast that is about to appear. Not for a
    // DOWNLOAD: that wrote a copy to Downloads and left the open file stale, so
    // adopting it would tell the next cycle the file is current when it is the
    // one thing that is not.
    if (r !== 'downloaded') writeBack.adopt(store.doc)
    const name = currentFileName()
    if (r === 'downloaded') {
      toast(t('This browser cannot write files in place, so a copy was saved to your Downloads. The file open here is unchanged.'))
    } else if (r === 'saved-as' && name) {
      toast(t('Saved to {name}').replace('{name}', name))
    } else {
      toast(t('Saved'))
    }
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
      // `replaceDoc` does NOT check `store.readOnly` — it is the load path, not
      // an edit path — so every caller defends the frozen workbook itself
      // (about.ts `replaceWorkbook`, recovery.ts `swapWorkbook`). This is the
      // same door with no dialog in front of it: an agent harness holding a
      // workbook frozen by an unknown policy would otherwise write to it
      // through the scripting API, which is the one route with no user at all
      // to notice.
      if (refuseWrite(findingsEl, store)) return false
      const r = parseDoc(json)
      if (!r.ok) return false
      // Validate and REPORT, never refuse. The document is the user's data,
      // and refusing to load a workbook whose columns disagree loses more than
      // loading it and saying so.
      const v = validateDoc(r.doc)
      store.replaceDoc(r.doc)
      showFindings(findingsEl, v.findings.filter((f) => f.severity === 'fatal') as never)
      return true
    },
    /** Check a workbook against itself — findings, never a refusal. */
    validate: (json?: string) => {
      if (json === undefined) return validateDoc(store.doc)
      const r = parseDoc(json)
      return r.ok ? validateDoc(r.doc) : {
        ok: false,
        counts: { fatal: 1, repairable: 0, suspicious: 0 },
        findings: [{ code: `parse-${r.err}`, severity: 'fatal' as const, message: r.err }],
      }
    },
    comments: () => flatComments(store.doc),
    /**
     * Ask the workbook a question.
     *
     * Compiles to `Step[]` and runs them, so the answer is a FRAME over the
     * same columns rather than a copy — and `steps` is the pipeline you could
     * paste into a sheet to make the answer live. That is the whole reason this
     * is a compiler and not an embedded database: a query result that is a copy
     * is wrong the moment anybody edits a cell.
     */
    sql: (text: string, opts?: { rows?: number }) => {
      const r = runSql(text, { doc: store.doc })
      showFindings(findingsEl, r.issues.filter((i) => i.severity === 'fatal') as never)
      return {
        ok: r.ok,
        issues: r.issues,
        steps: r.compiled.frames.map((f) => ({ name: f.name, from: f.from, steps: f.steps, select: f.select })),
        columns: r.frame ? r.frame.columns.map((c) => ({ id: c.id, name: c.name })) : [],
        n: r.frame ? r.frame.n : 0,
        rows: r.frame ? sqlRows(r.frame, opts?.rows ?? 100) : [],
      }
    },
    // Matches slides: 'x-pseudo' audits unswept strings without a reload, and a
    // harness can read the locale it is about to be judged in.
    i18n: i18nApi,
    addComment: () => comments.commentOnSelection(),
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

/**
 * Refuse a write to a locked workbook, and SAY SO.
 *
 * `store.commit` already no-ops when `readOnly` is set, which is enough to keep
 * the document intact but not enough to be honest: a file picker that opens, a
 * file that reads, and then nothing at all on screen reads as a bug in the
 * import, and the next thing the user does is try a different file. Worse, the
 * xlsx path never went through `commit` — it pushed onto `store.doc.sheets` and
 * called `replaceDoc`, which walks straight past the lock.
 */
function refuseWrite(host: HTMLElement, store: Store): boolean {
  if (!store.readOnly) return false
  showFindings(host, [{ message: t('This workbook is open read-only, so nothing can be written into it. Save a copy first.') }] as never)
  return true
}

function applyImport(store: Store, host: HTMLElement, grid: Grid, text: string, source: string): void {
  if (refuseWrite(host, store)) return
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
/**
 * Pick a column's type.
 *
 * A POPOVER, not `window.prompt`. Import refuses to guess a type it cannot
 * decide and says so, and that refusal is only honest if fixing it is one
 * click — which it was not when the click opened a native dialog asking the
 * reader to type the NUMBER of the type they wanted from a list.
 */
function retype(store: Store, col: Column, x: number, y: number): void {
  const types: ColumnType[] = ['text', 'number', 'money', 'percent', 'date', 'bool']
  const el = popover(x, y, types.map((tp) =>
    `<button data-t="${tp}"${tp === col.type ? ' class="dx-pop-on"' : ''}>` +
    `${esc(TYPE_LABEL[tp])}${tp === col.type ? ' ✓' : ''}</button>`).join(''))
  const sheet = store.doc.sheets.find((s) =>
    s.kind === 'table' && s.columns.some((c) => c.id === col.id)) as TableSheet | undefined
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.t as ColumnType
      el.remove()
      if (!sheet || next === col.type) return
      // Through the shared helper, like the panel's dropdown: a type change can
      // be refused, and this menu closes itself before the commit — so without
      // a report the reader picks a type, the menu vanishes, and nothing at all
      // happens or explains why.
      setColumnType(store, sheet.id, col.id, next, toast)
    }
  })
}

// --- export -----------------------------------------------------------------

/**
 * The sheet on screen, as a CSV.
 *
 * THE SHEET IS PASSED IN, and that is the whole fix. This used to be
 * `sheets.find(kind === 'table')` — the FIRST dataset in the workbook, not the
 * one the reader is looking at. With one sheet it was indistinguishable from
 * correct; with tabs, "Download this sheet as CSV" on sheet four wrote sheet
 * one, under sheet four's name, with no indication at all. On a spreadsheet tab
 * it wrote a dataset the reader might not even have open. docs/dash-sheet-kinds
 * calls this defect out by name.
 */
function exportCsv(store: Store, sheet: TableSheet): void {
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

// A FUNCTION DECLARATION, and it has to stay one. The boot dispatcher above
// calls boot() during module evaluation — i.e. before this line runs — so as a
// `const esc = …` arrow this sat in the temporal dead zone for the entire
// first paint. Nothing noticed while only refuse() used it; the moment the top
// bar did, every load died on "Cannot access 'esc' before initialization" with
// the splash still up and nothing in the console (the boot try/catch swallows
// it into the dark card). A declaration hoists, so the landmine is gone.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// referenced so the budget constants are not tree-shaken out of the bundle,
// and so a reader of this file sees both halves of the rule in one place
void DOC_BUDGET_FSA
void DOC_BUDGET_DOWNLOAD

// --- formulas ---------------------------------------------------------------

/**
 * Add a computed column. One expression for the whole column, so inserting a
 * row changes nothing and there is no range to fall out of date.
 */
/**
 * Check a formula against the sheet it will live on, as it is typed.
 *
 * `dependencies` returns the names the expression refers to, so a typo in a
 * column name is caught here rather than becoming a column of #NAME? that the
 * author discovers later. It cannot catch everything — a syntax error still
 * surfaces as an error VALUE in the column — but a misspelt column is the
 * mistake people actually make, and it is the one a native prompt could never
 * have reported.
 */
function formulaProblem(sheet: TableSheet, expr: string): string | null {
  if (!expr.trim()) return null                       // empty clears the formula
  const known = new Set(sheet.columns.map((c) => c.name))
  const fns = new Set(FUNCTIONS)
  const unknown = dependencies(expr).filter((d) => !known.has(d) && !fns.has(d.toUpperCase()))
  if (!unknown.length) return null
  return t('No column called {name} on this sheet.').replace('{name}', `“${unknown[0]}”`)
}

/** The columns you may name, for the hint line under the field. */
const columnHint = (sheet: TableSheet): string =>
  `${t('Columns')}: ${sheet.columns.map((c) => (/\s/.test(c.name) ? `[${c.name}]` : c.name)).join(', ')}`

async function addFormula(store: Store, sheet: TableSheet): Promise<void> {
  // The old default was literally `Value * Probability` — the starter
  // workbook's own column names, prefilled into every workbook in the world.
  // On any other sheet it is a formula referring to two columns that do not
  // exist, presented as the example to follow.
  const nums = sheet.columns.filter((c) => c.type === 'number' || c.type === 'money' || c.type === 'percent')
  const example = nums.length >= 2 ? `${nums[0].name} * ${nums[1].name}` : nums.length === 1 ? `${nums[0].name} * 2` : ''
  const got = await askForm({
    title: t('New formula column'),
    fields: [
      { key: 'expr', label: t('Formula'), value: example, mono: true, placeholder: t('e.g. Price * Quantity') },
      { key: 'name', label: t('Column name'), value: t('Computed') },
    ],
    hint: `${columnHint(sheet)}\n${t('Functions')}: ${FUNCTIONS.slice(0, 24).join(' ')}…`,
    submit: t('Add column'),
    check: (v) => (v.expr.trim() ? formulaProblem(sheet, v.expr) : t('A formula column needs a formula.')),
  })
  if (!got) return
  const id = `f-${Math.floor(Date.now() % 1e8).toString(36)}`
  // THE TYPE COMES FROM WHAT THE EXPRESSION RETURNS, not from a constant. This
  // line used to read `type: 'number'` — so a column of surnames arrived
  // badged NUMBER, right-aligned, filtered with numeric operators and totalling
  // to nothing. computedtype.ts runs the expression against this sheet and
  // judges the values; when they cannot be judged it says text, which is the
  // type that makes no claim.
  store.commit({
    op: 'addColumn', sheet: sheet.id,
    column: {
      id, name: got.name.trim() || t('Computed'),
      type: inferComputedType(sheet, got.expr).type, formula: got.expr,
    },
  })
}

/** Double-clicking a computed cell edits the expression that produced it. */
async function editFormula(store: Store, sheet: TableSheet, col: Column): Promise<void> {
  const got = await askForm({
    title: t('Formula for “{col}”').replace('{col}', col.name),
    fields: [{ key: 'expr', label: t('Formula'), value: col.formula ?? '', mono: true }],
    hint: `${columnHint(sheet)}\n${t('Leave it empty to turn this back into an ordinary column.')}`,
    submit: t('Save formula'),
    check: (v) => formulaProblem(sheet, v.expr),
  })
  if (!got) return
  if (!got.expr.trim()) {
    store.commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { formula: undefined } })
    return
  }
  // RE-INFER, BUT NEVER OVERRULE A PERSON. Changing `Value * Rate` to a text
  // split should re-type the column, or the badge goes on lying — but a type
  // somebody chose by hand in the panel is a decision, and silently undoing it
  // on the next formula edit is the worse of the two failures. So the type
  // moves only while it still matches what the OLD expression produced, which
  // is exactly the case "nobody has touched this".
  const before = inferComputedType(sheet, col.formula ?? '', col.id)
  const after = inferComputedType(sheet, got.expr, col.id)
  const retype = col.type === before.type && after.type !== col.type
  store.commit({
    op: 'setColumn', sheet: sheet.id, col: col.id,
    patch: retype ? { formula: got.expr, type: after.type } : { formula: got.expr },
  })
}


// --- menus -------------------------------------------------------------------

/** A small popover, dismissed by the next click anywhere. */
/**
 * A small modal form — the replacement for `window.prompt`.
 *
 * WHY THIS EXISTS AT ALL. Four call sites used `window.prompt`, and one of them
 * was the Formula button, the app's headline feature. Native modals are not
 * available everywhere a self-contained HTML file is opened: embedded webviews
 * (Slack, Teams, an iOS mail preview), sandboxed iframes without `allow-modals`,
 * and any tab where the reader has ticked "prevent this page from creating
 * additional dialogs". In the return-null variant the button is simply dead; in
 * the throwing variant the click handler dies half-way through. Measured in this
 * project's own browser pane: clicking Formula did nothing at all — no dialog,
 * no column, no message, not even a console line. For a document whose entire
 * premise is that it opens anywhere, that is the wrong foundation.
 *
 * `prompt` also cannot do the things this form needs: two fields at once, a
 * list of the columns you may refer to, and an error that appears as you type
 * rather than after you commit. dash already made this argument once — see
 * `retype` above, "A POPOVER, not window.prompt" — and the topbar was simply
 * never converted.
 *
 * `check` runs on every keystroke: return a message to block submission and
 * show it, or null to allow. Resolves with the field values, or null if the
 * reader cancelled.
 */
interface AskField {
  key: string
  label: string
  value?: string
  placeholder?: string
  /** formulas and ids are read character by character; prose is not */
  mono?: boolean
}

function askForm(opts: {
  title: string
  fields: AskField[]
  hint?: string
  submit?: string
  check?: (values: Record<string, string>) => string | null
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    document.querySelector('.dx-ask-back')?.remove()
    const back = document.createElement('div')
    back.className = 'dx-ask-back'
    const card = document.createElement('div')
    card.className = 'dx-ask'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')

    const h = document.createElement('h2')
    h.className = 'dx-ask-title'
    h.textContent = opts.title
    card.append(h)

    const inputs: Record<string, HTMLInputElement> = {}
    for (const f of opts.fields) {
      const row = document.createElement('label')
      row.className = 'dx-ask-row'
      const lab = document.createElement('span')
      lab.textContent = f.label
      const inp = document.createElement('input')
      inp.className = `dx-ask-in${f.mono ? ' dx-ask-mono' : ''}`
      inp.value = f.value ?? ''
      if (f.placeholder) inp.placeholder = f.placeholder
      inp.spellcheck = false
      row.append(lab, inp)
      card.append(row)
      inputs[f.key] = inp
    }

    if (opts.hint) {
      const hint = document.createElement('p')
      hint.className = 'dx-ask-hint'
      hint.textContent = opts.hint
      card.append(hint)
    }

    const err = document.createElement('p')
    err.className = 'dx-ask-err'
    err.hidden = true
    card.append(err)

    const foot = document.createElement('div')
    foot.className = 'dx-ask-foot'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dx-btn'
    cancel.textContent = t('Cancel')
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'dx-btn dx-ask-go'
    ok.textContent = opts.submit ?? t('OK')
    foot.append(cancel, ok)
    card.append(foot)

    const values = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const k of Object.keys(inputs)) out[k] = inputs[k].value
      return out
    }
    const validate = (): boolean => {
      const msg = opts.check ? opts.check(values()) : null
      err.hidden = !msg
      err.textContent = msg ?? ''
      ok.disabled = !!msg
      return !msg
    }

    const done = (v: Record<string, string> | null): void => {
      back.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(v)
    }
    // CAPTURE phase, and stopped here: the grid has a document-level key
    // handler that turns a printable character into a cell edit, so without
    // this, typing a formula also types it into the sheet behind the dialog.
    const onKey = (e: KeyboardEvent): void => {
      if (!back.contains(e.target as Node)) return
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); done(null) }
      else if (e.key === 'Enter' && validate()) { e.preventDefault(); done(values()) }
    }
    document.addEventListener('keydown', onKey, true)

    for (const k of Object.keys(inputs)) inputs[k].addEventListener('input', validate)
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', () => { if (validate()) done(values()) })
    // A click on the backdrop cancels; a click inside must not.
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null) })

    back.append(card)
    document.body.append(back)
    validate()
    inputs[opts.fields[0].key]?.focus()
    inputs[opts.fields[0].key]?.select()
  })
}


/** Open a .xlsx. Every worksheet arrives as its own dash sheet. */
async function pickXlsx(store: Store, host: HTMLElement, grid: Grid): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (!f) return
    if (refuseWrite(host, store)) return
    void f.arrayBuffer().then(async (buf) => {
      try {
        // See dropopen.ts for why `names` and `installNames` are one change:
        // the live-formula gate trusts that a name it was told about exists.
        const r = await importXlsx(new Uint8Array(buf), {
          source: f.name, at: new Date().toISOString(),
          idPrefix: `xl-${Math.floor(Date.now() % 1e8).toString(36)}`,
          names: true,
        })
        store.doc.sheets.push(...r.sheets)
        installNames(store.doc, r.names)
        store.replaceDoc(store.doc)
        if (r.sheets.length) grid.setSheet(r.sheets[0].id)
        showFindings(host, r.findings as never)
      } catch (e) {
        // A refusal, not a crash: the file on disk is untouched.
        showFindings(host, [{ message: `${t('That .xlsx could not be opened.')} ${e instanceof Error ? e.message : String(e)}` }] as never)
      }
    })
  })
  input.click()
}

/**
 * Save as .xlsx. `grid.computed` carries the formula columns' VALUES, which are
 * never stored — without them a computed column exports empty, and the exporter
 * says so in its findings rather than shipping blanks quietly.
 */
async function saveXlsx(
  store: Store, host: HTMLElement,
  shown: { id: string; computed: Map<string, unknown[]> } | null,
): Promise<void> {
  // WHAT IS NOT IN THE FILE HAS TO BE SAID. `exportXlsx` writes dataset sheets
  // and skips every other kind in silence, so a workbook of two datasets and a
  // spreadsheet downloads as a plausible-looking .xlsx that is quietly missing a
  // third of the work. It reports the no-datasets case itself; the dropped ones
  // it does not, and a colleague opening the file has no way to know.
  const dropped = store.doc.sheets.filter((s) => s.kind !== 'table')
  if (dropped.length === store.doc.sheets.length) {
    showFindings(host, [{
      message: t('This workbook has no dataset sheet, and .xlsx export writes datasets. Nothing was downloaded.'),
    }])
    return
  }
  const r = await exportXlsx(store.doc, {
    at: new Date(),
    computed: shown ? { [shown.id]: shown.computed } : {},
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([r.bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))
  a.download = xlsxFileName(store.doc.title)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  showFindings(host, [
    ...(r.findings as unknown as Notice[]),
    ...(dropped.length ? [{
      message: t('{n} sheet(s) are not datasets and are not in the .xlsx: {names}.')
        .replace('{n}', String(dropped.length))
        .replace('{names}', dropped.map((s) => s.name).join(', ')),
    }] : []),
  ])
}

