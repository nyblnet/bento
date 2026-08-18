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
} from '../../kernel/src/save.ts'
import { putRecovery, pruneOld } from '../../kernel/src/autosave.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { mountAbout, openAbout, rememberVersion } from './about.ts'
import { mountPanels } from './panels.ts'
import { installStory } from './story.ts'
import { Dashboard } from './dashboard.ts'
import { SyncSession } from './sync/session.ts'
import { mountPeople } from './sync/people.ts'
import { ridBase, ridBlockFor } from './model.ts'
import { setRidBlock } from './rowcol.ts'
import { importXlsx, exportXlsx, xlsxFileName } from './xlsx.ts'
import { runPivot, mountPivot, defaultPivot, newPivotSheet, type PivotSpec } from './pivot.ts'
import { buildSheetPreview } from './preview.ts'
import { installSaveMenu, adoptOpenedDoc } from './saveui.ts'
import { dismissSplash, dismissSplashNow } from './splash.ts'
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
import { defaultBinding, renderChart, type ChartBinding } from './chart.ts'
import { readCell } from './store.ts'
import {
  insertRowsAt, deleteRowsAt, insertColumn, deleteColumn, resizeColumn,
  autoFitWidth, setHidden, freezeAt, readFrozen } from './rowcol.ts'
import { FUNCTIONS } from './formula.ts'
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
  data: SVG('<ellipse cx="10" cy="5.4" rx="5.6" ry="2.4"/><path d="M4.4 5.4v9.2c0 1.3 2.5 2.4 5.6 2.4s5.6-1.1 5.6-2.4V5.4"/><path d="M4.4 10c0 1.3 2.5 2.4 5.6 2.4s5.6-1.1 5.6-2.4"/>'),
  // Import and export get OPPOSITE arrows, not two copies of the cylinder. Four
  // rows reading "Import CSV / Export CSV / Import Excel / Export Excel" behind
  // the same glyph is four rows you have to read word by word; the arrow is
  // what lets you find the one you meant at a glance.
  imp: SVG('<path d="M10 3v8.5"/><path d="M6.6 8.2L10 11.6l3.4-3.4"/><path d="M4.2 13.6v2.2h11.6v-2.2"/>'),
  exp: SVG('<path d="M10 11.6V3.1"/><path d="M6.6 6.5L10 3.1l3.4 3.4"/><path d="M4.2 13.6v2.2h11.6v-2.2"/>'),
  save: SVG('<path d="M4.4 3.6h8.3l3.3 3.3v9.5H4.4z"/><path d="M7 3.6v4.2h5V3.6"/><path d="M7 16.4v-4.6h6v4.6"/>'),
  info: SVG('<circle cx="10" cy="10" r="7"/><path d="M10 9.2v4.4"/><path d="M10 6.6h.01"/>'),
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
  if (res.ok) boot(res.doc, res.repairs.length, res.frozen)
  else if (res.err === 'empty') boot(starterDoc(), 0, undefined)
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
    `<span class="dx-mark"><span class="dx-mark-b">bento</span><span class="dx-slash">/</span>dash</span>` +
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
    `<div class="dx-dd dx-data-dd">` +
    `<button class="dx-btn dx-dd-trig" data-dd="data" title="${esc(t('Import and export CSV and Excel files'))}">` +
    `${ICON.data}<span>${t('Data')}</span>${ICON.down}</button>` +
    `<div class="dx-menu">` +
    barBtn('import', ICON.imp, t('Import CSV…'), t('Add a sheet from a CSV or TSV file')) +
    barBtn('export', ICON.exp, t('Export CSV'), t('Download this sheet as CSV')) +
    `<div class="dx-menu-sep"></div>` +
    barBtn('import-xlsx', ICON.imp, t('Import Excel…'), t('Add sheets from an .xlsx workbook')) +
    barBtn('export-xlsx', ICON.exp, t('Export Excel'), t('Download this workbook as .xlsx')) +
    `</div></div>` +
    // Save keeps its label all the way down to a phone: it is the control the
    // user names when it is missing, and an unlabelled floppy is a guess.
    // The unsaved dot badges its corner rather than floating loose in the bar,
    // where it explained nothing (slides made the same move).
    `<button class="dx-btn dx-btn-save" data-act="save" title="${esc(t('Save this workbook (⌘S)'))}">` +
    `${ICON.save}<span class="dx-save-lab">${t('Save')}</span><span class="dx-dirty" hidden></span></button>` +
    barBtn('about', ICON.info, t('About'), t('About this workbook')) +
    `<span class="dx-ver">v${APP_VERSION}</span>` +
    `</div>` +
    `</header>` +
    `<div class="dx-formula"><span class="dx-ref">A1</span>` +
    `<span class="dx-fx-mark">fx</span>` +
    `<input class="dx-fx-input" spellcheck="false" placeholder="${t('value or = formula')}">` +
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

  // --- the formula bar and the status bar, both driven by the selection
  grid.onSelectionChange = (summary, ref, value) => {
    refEl.textContent = ref
    if (document.activeElement !== fxEl) fxEl.value = value
    sumEl.textContent = summary
  }
  fxEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    grid.setActiveCell(fxEl.value)
    fxEl.blur()
  })

  // --- the filter and sort menu, hung off each column header's caret
  grid.onFilterMenu = (colId, x, y) => openFilterMenu(store, grid, colId, x, y, viewEl)
  grid.onContextMenu = (row, ci, x, y) => openCellMenu(store, grid, row, ci, x, y)

  // keyboard: the grid owns the key set when nothing else has focus
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.isContentEditable)) return
    // A bare printable key REPLACES the selected cell — the most-used gesture
    // in a spreadsheet, and the one that makes a grid feel like one. It has to
    // be tried before keyToAction, which returns null for printable keys
    // precisely so that typing can reach here.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      if (grid.typeInto(e.key)) { e.preventDefault(); return }
    }
    if (grid.handleKey(e)) e.preventDefault()
  })
  grid.onRetype = (col, x, y) => retype(store, col, x, y)
  grid.onEditFormula = (col) => editFormula(store, grid, col)

  // --- chart: bound to columns, derived at render, never stored
  const chartEl = app.querySelector<HTMLElement>('.dx-chart')!
  const chartBody = app.querySelector<HTMLElement>('.dx-chart-body')!
  const chartTitle = app.querySelector<HTMLElement>('.dx-chart-title')!
  const kindBtn = app.querySelector<HTMLElement>('.dx-chart-kind')!
  let binding: ChartBinding | null = null
  let teardown: (() => void) | null = null
  const KINDS: Array<ChartBinding['kind']> = ['bar', 'line', 'pie', 'scatter']

  const drawChart = () => {
    if (!binding || chartEl.hidden) return
    teardown?.()
    const sheet = grid.sheet
    chartTitle.textContent = `${sheet.columns.find((c) => c.id === binding!.x)?.name ?? ''} · ` +
      binding.series.map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id).join(', ')
    kindBtn.textContent = binding.kind[0].toUpperCase() + binding.kind.slice(1)
    // hand the grid's freshly computed formula columns in, so the chart shows
    // the numbers on screen rather than the raw columns underneath them
    teardown = renderChart(chartBody, sheet, binding, grid.computed as Map<string, unknown[]>)
  }
  store.on('doc', drawChart)
  kindBtn.addEventListener('click', () => {
    if (viz) {
      viz.kind = KINDS3D[(KINDS3D.indexOf(viz.kind) + 1) % KINDS3D.length]
      draw3d()
      return
    }
    if (!binding) return
    binding.kind = KINDS[(KINDS.indexOf(binding.kind) + 1) % KINDS.length]
    drawChart()
  })
  app.querySelector('.dx-chart-close')!.addEventListener('click', () => {
    chartEl.hidden = true
    clearPivot()
    teardown?.(); teardown = null
    vizDown?.(); vizDown = null; viz = null
  })
  app.querySelector('[data-act="chart"]')!.addEventListener('click', () => {
    clearPivot()
    vizDown?.(); vizDown = null; viz = null
    binding = defaultBinding(grid.sheet)
    if (!binding) { showFindings(findingsEl, [{ message: t('This sheet has no numeric column to chart yet.') }]); return }
    chartEl.hidden = false
    drawChart()
  })
  app.querySelector('[data-act="formula"]')!.addEventListener('click', () => addFormula(store, grid))

  // --- 3D: the same panel, a different renderer. Geometry is derived from the
  // columns exactly as the 2D chart's series are, so nothing is stored.
  let viz: Viz3dBinding | null = null
  let vizDown: (() => void) | null = null
  const KINDS3D: Viz3dKind[] = ['scatter', 'surface', 'bars', 'globe']
  const draw3d = () => {
    if (!viz || chartEl.hidden) return
    vizDown?.(); teardown?.(); teardown = null
    const sheet = grid.sheet
    chartTitle.textContent = `3D ${viz.kind} · ` +
      [viz.x, viz.y, viz.z, viz.lat, viz.lon].filter(Boolean)
        .map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id).join(' / ')
    kindBtn.textContent = viz.kind[0].toUpperCase() + viz.kind.slice(1)
    const scene = buildScene(sheet, viz, grid.computed as Map<string, unknown[]>)
    vizDown = mountViz3d(chartBody, scene)
  }
  store.on('doc', () => { if (viz) draw3d() })
  app.querySelector('[data-act="viz3d"]')!.addEventListener('click', () => {
    clearPivot()
    viz = defaultViz3d(grid.sheet)
    if (!viz) {
      showFindings(findingsEl, [{ message: t('This sheet needs at least three numeric columns, or a latitude and longitude, to plot in 3D.') }])
      return
    }
    binding = null
    chartEl.hidden = false
    draw3d()
  })

  // Sheets on the left, properties on the right — the suite's shared chrome.
  // AFTER grid.onSelectionChange is set: mountPanels CHAINS that callback
  // rather than replacing it, so the formula bar and status bar keep working.
  mountPanels({ store, grid, body: app.querySelector<HTMLElement>('.dx-body')! })

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
    const computed = grid.computed as Map<string, unknown[]>
    pivotDown = mountPivot(chartBody, runPivot(src, pivotSpec, { computed }), { sheet: src, computed })
  }
  const clearPivot = (): void => {
    pivotDown?.(); pivotDown = null; pivotSpec = null
    kindBtn.hidden = false
  }
  store.on('doc', () => { if (pivotSpec) drawPivot() })

  app.querySelector('[data-act="import-xlsx"]')!.addEventListener('click', () => {
    void pickXlsx(store, findingsEl, grid)
  })
  app.querySelector('[data-act="export-xlsx"]')!.addEventListener('click', () => {
    void saveXlsx(store, grid, findingsEl)
  })

  app.querySelector('[data-act="pivot"]')!.addEventListener('click', () => {
    const spec = defaultPivot(grid.sheet)
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
      sheet: newPivotSheet(id, `${grid.sheet.name} — ${t('pivot')}`, spec),
    } as never)
    binding = null; viz = null; vizDown?.(); vizDown = null
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
  installStory({
    store,
    button: app.querySelector<HTMLElement>('[data-act="story"]')!,
    sheetId: () => grid.sheet.id,
    filters: () => grid.filters,
    sorts: () => grid.sorts,
    chart: () => binding,
    viz: () => viz,
    computed: (id) => (id === grid.sheet.id ? (grid.computed as Map<string, unknown[]>) : undefined),
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
        void putRecovery(store.doc)
        // the timeline the About dialog restores from — throttled inside, and
        // it refuses an encrypted workbook for the same reason putRecovery does
        void rememberVersion(store.doc)
      }
    }, 2500)
  }
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
    showingSheet: () => grid.sheet.id,
    showSheet: (id: string) => grid.setSheet(id),
    onDirty: markDirty,
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
  // …and an EXPLICIT way in. mountAbout only arms the wordmark and the version
  // chip, and nobody guesses that a logo is a button — the chip, meanwhile, is
  // the first thing the responsive rules drop. The ⓘ button is the real door;
  // the other two stay as shortcuts for whoever already found them.
  app.querySelector('[data-act="about"]')!.addEventListener('click', () => openAbout(aboutHooks))
  void pruneOld()

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
      store.commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { type: next } })
    }
  })
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
function addFormula(store: Store, grid: Grid): void {
  const sheet = grid.sheet
  const names = sheet.columns.map((c) => (/\s/.test(c.name) ? `[${c.name}]` : c.name)).join(', ')
  const expr = window.prompt(
    `${t('Formula for a new column.')}\n\n${t('Columns')}: ${names}\n${t('Functions')}: ${FUNCTIONS.slice(0, 24).join(' ')}…\n\n` +
    `${t('Example')}: Value * Probability`,
    'Value * Probability',
  )
  if (!expr) return
  const name = window.prompt(t('Column name'), t('Computed')) || t('Computed')
  const id = `f-${Math.floor(Date.now() % 1e8).toString(36)}`
  store.commit({
    op: 'addColumn', sheet: sheet.id,
    column: { id, name, type: 'number', formula: expr },
  })
}

/** Double-clicking a computed cell edits the expression that produced it. */
function editFormula(store: Store, grid: Grid, col: Column): void {
  const expr = window.prompt(`${t('Formula for')} "${col.name}"`, col.formula ?? '')
  if (expr === null) return
  store.commit({
    op: 'setColumn', sheet: grid.sheet.id, col: col.id,
    patch: expr.trim() ? { formula: expr } : { formula: undefined },
  })
}


// --- menus -------------------------------------------------------------------

/** A small popover, dismissed by the next click anywhere. */
function popover(x: number, y: number, html: string): HTMLElement {
  document.querySelector('.dx-pop')?.remove()
  const el = document.createElement('div')
  el.className = 'dx-pop'
  el.style.left = `${Math.min(x, innerWidth - 260)}px`
  el.style.top = `${Math.min(y, innerHeight - 40)}px`
  el.innerHTML = html
  document.body.appendChild(el)
  setTimeout(() => {
    const off = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) { el.remove(); document.removeEventListener('mousedown', off) }
    }
    document.addEventListener('mousedown', off)
  }, 0)
  return el
}

/** Sort and filter for one column — the caret in its header. */
function openFilterMenu(
  store: Store, grid: Grid, colId: string, x: number, y: number, viewEl: HTMLElement,
): void {
  const col = grid.sheet.columns.find((c) => c.id === colId)
  if (!col) return
  const numeric = col.type === 'number' || col.type === 'money' || col.type === 'percent'
  const el = popover(x, y,
    `<button data-a="asc">${t('Sort A → Z')}</button>` +
    `<button data-a="desc">${t('Sort Z → A')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<label class="dx-pop-row"><span>${numeric ? t('Greater than') : t('Contains')}</span>` +
    `<input class="dx-pop-in" spellcheck="false"></label>` +
    `<button data-a="apply">${t('Apply filter')}</button>` +
    `<button data-a="clear">${t('Clear filters and sorts')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="hide">${t('Hide this column')}</button>` +
    `<button data-a="fit">${t('Fit width to content')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="freeze">${frozenTo(grid, colId) ? t('Unfreeze columns') : t('Freeze up to this column')}</button>`)
  const input = el.querySelector<HTMLInputElement>('.dx-pop-in')!
  const showView = () => {
    const n = store.order[grid.sheet.id]?.length
    viewEl.textContent = n === undefined ? ''
      : t('{n} of {all} rows').replace('{n}', String(n))
          .replace('{all}', String(grid.sheet.rids.reduce((a, [, c]) => a + c, 0)))
  }
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a
      if (a === 'asc' || a === 'desc') grid.addSort(colId, a)
      else if (a === 'apply') {
        const v = input.value.trim()
        // `v`, not `value` — and NO `as never`. The cast is what let this
        // compile: filter.ts spells the payload `v`, so `{op:'greater',
        // value:…}` reached the predicate with an undefined bound. Measured
        // before the fix: "greater than 10000" left 0 of 8 rows, and `contains`
        // matched everything, so the feature looked inert rather than wrong.
        grid.setFilter(colId, v === '' ? null : {
          col: colId,
          pred: numeric
            ? { op: 'greater', v: Number(v.replace(/[,\s£$€¥%]/g, '')) }
            : { op: 'contains', v },
        })
      } else if (a === 'clear') grid.clearView()
      else if (a === 'hide') store.commit(setHidden(grid.sheet, colId, true))
      else if (a === 'freeze') {
        // "up to this column" counts VISIBLE position, which is what the reader
        // pointed at; a hidden column between them would otherwise freeze one
        // more column than the menu item named.
        const at = grid.sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === colId)
        store.commit(freezeAt(grid.sheet, 0, frozenTo(grid, colId) ? 0 : at + 1))
      }
      else if (a === 'fit') {
        const sh = grid.sheet
        const comp = grid.computed.get(colId)
        store.commit(resizeColumn(sh, colId,
          autoFitWidth((row) => comp ? comp[row] : readCellOf(sh, colId, row), col,
            sh.rids.reduce((n, [, c]) => n + c, 0))))
      }
      showView()
      el.remove()
    }
  })
  input.focus()
}

/** Is the freeze already exactly at this column? Then the item offers to undo it. */
const frozenTo = (grid: Grid, colId: string): boolean => {
  const at = grid.sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === colId)
  return readFrozen(grid.sheet).cols === at + 1
}

/** Open a .xlsx. Every worksheet arrives as its own dash sheet. */
async function pickXlsx(store: Store, host: HTMLElement, grid: Grid): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (!f) return
    void f.arrayBuffer().then(async (buf) => {
      try {
        const r = await importXlsx(new Uint8Array(buf), {
          source: f.name, at: new Date().toISOString(),
          idPrefix: `xl-${Math.floor(Date.now() % 1e8).toString(36)}`,
        })
        store.doc.sheets.push(...r.sheets)
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
async function saveXlsx(store: Store, grid: Grid, host: HTMLElement): Promise<void> {
  const r = await exportXlsx(store.doc, {
    at: new Date(),
    computed: { [grid.sheet.id]: grid.computed as Map<string, unknown[]> },
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([r.bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))
  a.download = xlsxFileName(store.doc.title)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  showFindings(host, r.findings as never)
}

const readCellOf = (sheet: TableSheet, colId: string, row: number): unknown =>
  readCell(sheet.data[colId], row)

/** Right-click on the grid: the structural operations. */
function openCellMenu(store: Store, grid: Grid, row: number, ci: number, x: number, y: number): void {
  const sheet = grid.sheet
  const col = sheet.columns[ci]
  const el = popover(x, y,
    `<button data-a="irow-above">${t('Insert row above')}</button>` +
    `<button data-a="irow-below">${t('Insert row below')}</button>` +
    `<button data-a="drow">${t('Delete row')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="icol">${t('Insert column')}</button>` +
    `<button data-a="dcol">${t('Delete column')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="fill">${t('Fill down')}</button>` +
    `<button data-a="clear">${t('Clear contents')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="cf-scale">${t('Colour scale')}</button>` +
    `<button data-a="cf-bar">${t('Data bars')}</button>` +
    `<button data-a="cf-off">${t('Remove formatting')}</button>`)
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a
      // `row` is a VISIBLE index and every structural op takes a canonical
      // one. They differ the moment somebody sorts, and passing the wrong one
      // deletes the wrong row — silently, because the view re-sorts over the
      // evidence. Each edit also carries the reference shift for the cell
      // formulas, in the SAME commit: a document where the rows have moved and
      // the formulas have not is a workbook of plausible wrong numbers.
      const at = grid.canonicalRow(row)
      if (a === 'irow-above') {
        store.commit([...insertRowsAt(sheet, at, 1), ...grid.shiftFormulas('row', at, 1)])
      } else if (a === 'irow-below') {
        store.commit([...insertRowsAt(sheet, at + 1, 1), ...grid.shiftFormulas('row', at + 1, 1)])
      } else if (a === 'drow') {
        store.commit([...deleteRowsAt(sheet, at, 1), ...grid.shiftFormulas('row', at, -1)])
      } else if (a === 'icol') {
        const name = window.prompt(t('Column name'), t('New column')) || t('New column')
        const id = `c-${Math.floor(Date.now() % 1e8).toString(36)}`
        const cAt = sheet.columns.findIndex((c) => c.id === col?.id) + 1
        store.commit([...insertColumn(sheet, cAt, { id, name, type: 'text' }),
          ...grid.shiftFormulas('col', cAt, 1)])
      } else if (a === 'dcol' && col) {
        const cAt = sheet.columns.findIndex((c) => c.id === col.id)
        store.commit([...deleteColumn(sheet, col.id), ...grid.shiftFormulas('col', cAt, -1)])
      }
      else if (a === 'fill') grid.fillDownSelection()
      else if (a === 'clear') grid.clearSelection()
      else if (col && (a === 'cf-scale' || a === 'cf-bar' || a === 'cf-off')) {
        // Conditional formats are DOCUMENT data — they travel with the file —
        // and live in an additive field, so an older build keeps them.
        const cf = { ...((sheet as unknown as { condfmt?: Record<string, unknown> }).condfmt ?? {}) }
        if (a === 'cf-off') delete cf[col.id]
        else if (a === 'cf-scale') cf[col.id] = [{ kind: 'colorScale', colors: ['#fee2e2', '#fef9c3', '#dcfce7'] }]
        else cf[col.id] = [{ kind: 'dataBar', color: '#F7A600', negativeColor: '#E1616C' }]
        store.commit({ op: 'setSheetProps', sheet: sheet.id, props: { condfmt: cf } } as never)
      }
      el.remove()
    }
  })
}
