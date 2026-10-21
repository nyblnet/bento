// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The pivot's field editor — rows, columns, values and filters, the way every
// peer lays them out (Excel's PivotTable Fields, Sheets' pivot editor, Numbers'
// Pivot Options): the source's columns in a list, four areas under it, a field
// dragged or picked into an area.
//
// A PIVOT THAT CAN ONLY BE GUESSED IS NOT A PIVOT. `defaultPivot` picks Region ×
// Owner, sum of Value, and until this file existed that guess was the whole of
// what a pivot could be: no way to group by Stage, to count rather than sum, or
// to leave out the lost deals. A summary whose question somebody else chose is
// a chart of the wrong thing.
//
// EVERY EDIT IS A SPEC, AND THE SPEC IS THE DOCUMENT. The operations at the top
// of this file are pure functions from one `PivotSpec` to the next — no DOM, so
// `scripts/test-dash-pivotfields.ts` holds them to the rules a drag gesture is
// easy to get wrong:
//
//   1. A GROUPING FIELD IS IN ONE PLACE. Region in Rows AND Columns is a
//      diagonal of one-cell groups; Region in Rows and Filters disagrees with
//      itself. Moving a field between those three areas MOVES it.
//   2. VALUES ARE NOT GROUPING. "Count of Region" beside Region in Rows is a
//      legitimate question, and so is Sum and Average of Value side by side —
//      so Values may repeat a column, but never the same column AND function
//      twice (two identical columns of numbers read as a rendering bug).
//   3. THE FILTERS AREA STORES THE JSON SPELLING. A checklist is `values`, an
//      array; filter.ts's `Set` serializes as `{}` and would reopen matching
//      nothing (model.ts `StoredFilter`).
//   4. AN EDIT NEVER MUTATES ITS INPUT. The spec it is handed is the one inside
//      `store.doc`; mutating it in place is a change the undo stack never saw.

import './pivotfields.css'
import type { Column, TableSheet } from './model.ts'
import type { PanelKit } from './cellprops.ts'
import {
  AGG_FNS, isPivotSheet, readPivotSpec,
  type AggFn, type PivotFilter, type PivotSheet, type PivotSpec, type PivotValue,
} from './pivot.ts'
import { distinctValues, matchKey, BLANK_KEY } from './filter.ts'
import { readCell } from './store.ts'
import { listLabel, TYPE_LABEL } from './format.ts'
import { t } from './i18n.ts'

// --- the operations ---------------------------------------------------------

export type Area = 'filters' | 'cols' | 'rows' | 'values'

const isMeasure = (c: Pick<Column, 'type'> | undefined): boolean =>
  !!c && (c.type === 'number' || c.type === 'money' || c.type === 'percent')

/**
 * What a field means when it lands in Values with no function chosen. A
 * measure is summed — that is the question asked of a money column nine times
 * in ten. Anything else is COUNTED, because a sum of text is not a number and
 * printing an empty column under "Sum of Region" is a broken pivot, not an
 * answer.
 */
export const defaultAgg = (c: Pick<Column, 'type'> | undefined): AggFn =>
  isMeasure(c) ? 'sum' : 'count'

const clone = (spec: PivotSpec): PivotSpec => ({
  ...spec,
  rows: [...spec.rows],
  cols: [...spec.cols],
  values: spec.values.map((v) => ({ ...v })),
  ...(spec.filters ? { filters: spec.filters.map((f) => ({ ...f })) } : {}),
})

/** The filter-area columns, in order. */
export const filterCols = (spec: PivotSpec): string[] =>
  (spec.filters ?? []).filter((f) => f && typeof f.col === 'string').map((f) => f.col)

/** Which areas hold this column. */
export function fieldAreas(spec: PivotSpec, col: string): Area[] {
  const out: Area[] = []
  if (filterCols(spec).includes(col)) out.push('filters')
  if (spec.cols.includes(col)) out.push('cols')
  if (spec.rows.includes(col)) out.push('rows')
  if (spec.values.some((v) => v.col === col)) out.push('values')
  return out
}

/** Take a column out of every GROUPING area (Values untouched). */
function ungroup(s: PivotSpec, col: string): void {
  s.rows = s.rows.filter((c) => c !== col)
  s.cols = s.cols.filter((c) => c !== col)
  if (s.filters) {
    s.filters = s.filters.filter((f) => f.col !== col)
    if (!s.filters.length) delete s.filters
  }
}

const clampAt = (at: number | undefined, len: number): number =>
  at === undefined || !Number.isFinite(at) ? len : Math.max(0, Math.min(len, Math.floor(at)))

/**
 * Put a column into an area, at a position (default: the end).
 *
 * Into a grouping area it MOVES — out of the other two first (rule 1) — and a
 * filter it carried along with it is dropped: a checklist on Region was a
 * statement about which regions to admit, and Region becoming a row field is
 * the author asking to see them all. Into Values it is ADDED with `fn` (or the
 * column's default), unless that exact column-and-function is already there
 * (rule 2), in which case the spec comes back unchanged.
 */
export function addField(
  spec: PivotSpec, col: string, area: Area,
  opts: { at?: number; fn?: AggFn; column?: Pick<Column, 'type'> } = {},
): PivotSpec {
  const s = clone(spec)
  if (area === 'values') {
    const fn = opts.fn ?? defaultAgg(opts.column)
    if (s.values.some((v) => v.col === col && v.fn === fn)) return spec
    s.values.splice(clampAt(opts.at, s.values.length), 0, { col, fn })
    return s
  }
  // Re-inserting into the SAME area at a later index: the index was measured
  // with the field still in the list, so it shifts by one once it is taken out.
  let at = opts.at
  const list = area === 'filters' ? filterCols(s) : s[area]
  const was = list.indexOf(col)
  if (was >= 0 && at !== undefined && at > was) at -= 1
  ungroup(s, col)
  if (area === 'filters') {
    const fs = s.filters ?? []
    fs.splice(clampAt(at, fs.length), 0, { col })
    s.filters = fs
  } else {
    s[area].splice(clampAt(at, s[area].length), 0, col)
  }
  return s
}

/** Take the `index`th entry out of an area. Out of range is a no-op. */
export function removeField(spec: PivotSpec, area: Area, index: number): PivotSpec {
  const s = clone(spec)
  if (area === 'values') {
    if (!s.values[index]) return spec
    s.values.splice(index, 1)
  } else if (area === 'filters') {
    if (!s.filters?.[index]) return spec
    s.filters.splice(index, 1)
    if (!s.filters.length) delete s.filters
  } else {
    if (index < 0 || index >= s[area].length) return spec
    s[area].splice(index, 1)
  }
  return s
}

/**
 * Drag from one area to another (or within one).
 *
 * Within an area it is a reorder — and a Values entry keeps its function and
 * its name through one. Across areas it is a remove then an add, so every rule
 * `addField` keeps is kept here too; a value dragged into Rows stops being a
 * value, and a row field dragged into Values becomes its default aggregate.
 */
export function moveField(
  spec: PivotSpec,
  from: { area: Area; index: number },
  to: { area: Area; index?: number },
  column?: Pick<Column, 'type'>,
): PivotSpec {
  const col = entryCol(spec, from.area, from.index)
  if (col === null) return spec
  if (from.area === to.area) {
    const s = clone(spec)
    if (from.area === 'values') {
      const [v] = s.values.splice(from.index, 1)
      let at = clampAt(to.index, s.values.length + 1)
      if (at > from.index) at -= 1
      s.values.splice(Math.min(at, s.values.length), 0, v)
      return s
    }
    if (from.area === 'filters') {
      const fs = s.filters!
      const [f] = fs.splice(from.index, 1)
      let at = clampAt(to.index, fs.length + 1)
      if (at > from.index) at -= 1
      fs.splice(Math.min(at, fs.length), 0, f)
      return s
    }
    return addField(spec, col, to.area, { at: to.index })
  }
  const out = removeField(spec, from.area, from.index)
  return addField(out, col, to.area, { at: to.index, column })
}

function entryCol(spec: PivotSpec, area: Area, index: number): string | null {
  if (area === 'values') return spec.values[index]?.col ?? null
  if (area === 'filters') return filterCols(spec)[index] ?? null
  return spec[area][index] ?? null
}

/**
 * Change a value's aggregate. A switch that would make it identical to another
 * value already in the list is refused (spec unchanged), for rule 2.
 */
export function setAgg(spec: PivotSpec, index: number, fn: AggFn): PivotSpec {
  const v = spec.values[index]
  if (!v || v.fn === fn) return spec
  if (spec.values.some((w, i) => i !== index && w.col === v.col && w.fn === fn)) return spec
  const s = clone(spec)
  s.values[index] = { ...s.values[index], fn }
  return s
}

/**
 * Set which values of a Filters-area column are admitted. `null` is "(All)":
 * the field stays in the area and filters nothing. A column not yet in the area
 * is added to it. `null` in `values` is the "(Blanks)" box.
 */
export function setFilterValues(spec: PivotSpec, col: string, values: unknown[] | null): PivotSpec {
  const s = filterCols(spec).includes(col) ? clone(spec) : addField(spec, col, 'filters')
  s.filters = (s.filters ?? []).map((f) => {
    if (f.col !== col) return f
    const next: PivotFilter = { ...f }
    if (values === null) delete next.pred
    else next.pred = { op: 'isOneOf', values: [...values] }
    return next
  })
  return s
}

/**
 * The tick in the field list. Ticked → it leaves every area. Unticked → a
 * measure goes to Values (summed), anything else to Rows — Excel's rule, and
 * the one that makes ticking three boxes produce a pivot somebody wanted.
 */
export function toggleField(spec: PivotSpec, col: string, column?: Pick<Column, 'type'>): PivotSpec {
  if (fieldAreas(spec, col).length) {
    const s = clone(spec)
    ungroup(s, col)
    s.values = s.values.filter((v) => v.col !== col)
    return s
  }
  return addField(spec, col, isMeasure(column) ? 'values' : 'rows', { column })
}

// --- the editor -------------------------------------------------------------

/** Display labels for the aggregate menu. LITERAL t() calls, so the i18n rig
 *  sees every one (cellprops.ts `kindLabel` says why). */
const aggLabel = (fn: AggFn): string =>
  fn === 'sum' ? t('Sum')
    : fn === 'avg' ? t('Average')
      : fn === 'count' ? t('Count')
        : fn === 'min' ? t('Min')
          : fn === 'max' ? t('Max')
            : fn === 'median' ? t('Median')
              : t('Distinct')

const areaLabel = (a: Area): string =>
  a === 'filters' ? t('Filters') : a === 'cols' ? t('Columns') : a === 'rows' ? t('Rows') : t('Values')

const AREAS: readonly Area[] = ['filters', 'cols', 'rows', 'values']

/** The MIME type of a field being dragged — custom, so a drag of some other
 *  text from elsewhere on the page is never mistaken for a field. */
const DRAG_TYPE = 'application/x-bento-dash-pivot-field'

interface DragPayload { col: string; area?: Area; index?: number }

/** How many values a filter checklist lists before it says it stopped. */
const FILTER_CAP = 300

export interface PivotFieldsHost {
  host: HTMLElement
  kit: PanelKit
  /** the pivot sheet being edited */
  sheet: PivotSheet
  /** its source dataset, or null when that sheet is gone */
  source: TableSheet | null
  /** the source's computed columns, for the filter checklist */
  computed?: Map<string, unknown[]>
  readOnly: boolean
  /** write the next spec. The caller commits ONE patch for it. */
  commit(spec: PivotSpec): void
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Filter checklists left open survive the rebuild every commit causes. */
const openLists = new Set<string>()

/**
 * Draw the field editor into the properties panel.
 *
 * Re-drawn whole after every commit, like every other section of that panel —
 * the spec is small and the panel is rebuilt from the document, which is what
 * keeps it from disagreeing with an undo.
 */
export function buildPivotFields(o: PivotFieldsHost): void {
  const { host, kit } = o
  const read = readPivotSpec(o.sheet)
  if (!read || !isPivotSheet(o.sheet)) return
  const spec: PivotSpec = read
  const src = o.source
  const colOf = (id: string): Column | undefined => src?.columns.find((c) => c.id === id)
  const nameOf = (id: string): string => colOf(id)?.name ?? id
  const ro = o.readOnly
  const commit = (next: PivotSpec): void => { if (!ro && next !== spec) o.commit(next) }

  kit.section(host, t('Pivot table'))
  kit.readonlyRow(host, t('Source'), src ? src.name : t('(missing sheet)'))
  if (!src) {
    kit.note(host, t('The sheet this pivot summarised is not in the workbook any more.'))
    return
  }

  // --- the field list ---------------------------------------------------------
  kit.section(host, t('Fields'))
  const list = el('div', 'dpf-list')
  list.setAttribute('role', 'list')
  for (const c of src.columns) {
    const used = fieldAreas(spec, c.id)
    const item = el('label', 'dpf-field')
    item.setAttribute('role', 'listitem')
    item.dataset.col = c.id
    item.draggable = !ro
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = used.length > 0
    box.disabled = ro
    box.addEventListener('change', () => commit(toggleField(spec, c.id, c)))
    const name = el('span', 'dpf-field-name', c.name)
    const kind = el('span', 'dpf-field-type', t(TYPE_LABEL[c.type]))
    item.append(box, name, kind)
    if (used.length) {
      item.title = used.map(areaLabel).join(' · ')
      item.classList.add('dpf-used')
    }
    item.addEventListener('dragstart', (e) => startDrag(e, { col: c.id }))
    list.append(item)
  }
  host.append(list)
  // A field dragged back onto the list is taken OUT — Excel's gesture for
  // removing one, and the only place a drag can mean "nowhere".
  dropTarget(list, (p) => {
    if (p.area === undefined || p.index === undefined) return
    commit(removeField(spec, p.area, p.index))
  })
  if (!ro) kit.note(host, t('Drag a field into an area below, or tick it.'))

  // --- the four areas ---------------------------------------------------------
  for (const area of AREAS) {
    kit.section(host, areaLabel(area))
    const well = el('div', 'dpf-well')
    well.dataset.area = area
    const entries: string[] = area === 'values' ? spec.values.map((v) => v.col)
      : area === 'filters' ? filterCols(spec) : spec[area]
    entries.forEach((col, index) => well.append(chip(area, col, index)))
    if (!entries.length) {
      well.append(el('div', 'dpf-empty', area === 'values'
        ? t('Drop a field here to summarise it')
        : t('Drop a field here')))
    }
    if (!ro) well.append(adder(area))
    host.append(well)
    dropTarget(well, (p, e) => {
      const at = dropIndex(well, e.clientY)
      if (p.area === undefined || p.index === undefined) {
        commit(addField(spec, p.col, area, { at, column: colOf(p.col) }))
      } else {
        commit(moveField(spec, { area: p.area, index: p.index }, { area, index: at }, colOf(p.col)))
      }
    })
  }

  // --- options ----------------------------------------------------------------
  kit.section(host, t('Totals'))
  const opt = (label: string, on: boolean, set: (v: boolean) => PivotSpec): void => {
    const cb = kit.check(on, (v) => commit(set(v)))
    cb.disabled = ro
    kit.row(host, label, cb)
  }
  const flag = (key: 'subtotals' | 'grandTotals' | 'blanks', v: boolean): PivotSpec => {
    const s = clone(spec)
    // DEFAULT TRUE, so ON is spelled by ABSENCE: switching one off and back on
    // leaves the file exactly as it was (panels.ts `totalsPatch` makes the same
    // argument), and a collaborator sees no op for a pivot that is unchanged.
    if (v) delete s[key]; else s[key] = false
    return s
  }
  opt(t('Subtotals'), spec.subtotals !== false, (v) => flag('subtotals', v))
  opt(t('Grand totals'), spec.grandTotals !== false, (v) => flag('grandTotals', v))
  opt(t('Show (blank) groups'), spec.blanks !== false, (v) => flag('blanks', v))

  // --- pieces -----------------------------------------------------------------

  function chip(area: Area, col: string, index: number): HTMLElement {
    const c = el('div', 'dpf-chip')
    c.dataset.col = col
    c.dataset.index = String(index)
    c.draggable = !ro
    c.addEventListener('dragstart', (e) => startDrag(e, { col, area, index }))
    const missing = !colOf(col)
    if (missing) c.classList.add('dpf-missing')
    if (area === 'values') {
      const v: PivotValue = spec.values[index]
      const known = (AGG_FNS as string[]).includes(v.fn)
      const sel = kit.select(
        known ? AGG_FNS.map((fn) => [fn, aggLabel(fn)] as const) : [[String(v.fn), String(v.fn)] as const],
        String(v.fn),
        (fn) => commit(setAgg(spec, index, fn as AggFn)))
      sel.className = 'dpf-agg'
      sel.disabled = ro || !known
      sel.title = t('How to summarise {name}', { name: nameOf(col) })
      sel.setAttribute('aria-label', sel.title)
      c.append(sel, el('span', 'dpf-of', t('of')))
    }
    c.append(el('span', 'dpf-chip-name', nameOf(col)))
    if (missing) c.title = t('This column is not in {sheet} any more.', { sheet: src!.name })
    if (area === 'filters') {
      const f = (spec.filters ?? [])[index]
      const btn = el('button', 'dpf-filter-btn', filterSummary(f, col))
      btn.type = 'button'
      btn.title = t('Choose which values to include')
      btn.setAttribute('aria-expanded', String(openLists.has(col)))
      btn.addEventListener('click', () => {
        if (openLists.has(col)) openLists.delete(col); else openLists.add(col)
        const next = c.querySelector('.dpf-check')
        if (next) { next.remove(); btn.setAttribute('aria-expanded', 'false'); return }
        btn.setAttribute('aria-expanded', 'true')
        c.append(checklist(col, f))
      })
      c.append(btn)
    }
    if (!ro) {
      const x = el('button', 'dpf-x', '✕')
      x.type = 'button'
      x.title = t('Remove {name}', { name: nameOf(col) })
      x.setAttribute('aria-label', x.title)
      x.addEventListener('click', () => commit(removeField(spec, area, index)))
      c.append(x)
    }
    if (area === 'filters' && openLists.has(col)) c.append(checklist(col, (spec.filters ?? [])[index]))
    return c
  }

  function adder(area: Area): HTMLElement {
    const opts: Array<readonly [string, string]> = [['', t('Add field…')]]
    for (const c of src!.columns) {
      // A grouping area offers what is not already in it; Values offers every
      // column, because Sum AND Average of one column is a fair question.
      if (area !== 'values' && fieldAreas(spec, c.id).includes(area)) continue
      opts.push([c.id, c.name])
    }
    const sel = kit.select(opts, '', (id) => {
      if (!id) return
      commit(addField(spec, id, area, { column: colOf(id) }))
    })
    sel.className = 'dpf-add'
    sel.title = t('Add a field to {area}', { area: areaLabel(area) })
    sel.setAttribute('aria-label', sel.title)
    return sel
  }

  function filterSummary(f: PivotFilter | undefined, col: string): string {
    const p = f?.pred as { op?: string; values?: unknown[]; set?: Set<unknown> } | undefined
    if (!p) return t('All')
    if (p.op === 'isOneOf') {
      const vals = p.values ?? (p.set ? [...p.set] : [])
      if (vals.length === 1) return vals[0] === null ? t('(Blanks)') : listLabel(vals[0], colOf(col))
      return t('{n} selected', { n: vals.length })
    }
    return t('Custom')
  }

  function checklist(col: string, f: PivotFilter | undefined): HTMLElement {
    const box = el('div', 'dpf-check')
    const column = colOf(col)
    const n = src!.rids.reduce((a, [, k]) => a + k, 0)
    const comp = o.computed?.get(col)
    const get = (_c: string, r: number): unknown => (comp ? comp[r] : readCell(src!.data[col], r))
    const all = distinctValues(get, col, n, FILTER_CAP)
    const p = f?.pred as { op?: string; values?: unknown[] } | undefined
    const ticked = new Set<string>(p?.op === 'isOneOf' && Array.isArray(p.values)
      ? p.values.map(matchKey)
      : all.values.map(matchKey))
    const allBox = document.createElement('input')
    allBox.type = 'checkbox'
    allBox.checked = all.values.every((v) => ticked.has(matchKey(v)))
    allBox.disabled = ro
    const allRow = el('label', 'dpf-check-item dpf-check-all')
    allRow.append(allBox, el('span', '', t('(Select all)')))
    allBox.addEventListener('change', () => commit(setFilterValues(spec, col, allBox.checked ? null : [])))
    box.append(allRow)
    for (const v of all.values) {
      const k = matchKey(v)
      const row = el('label', 'dpf-check-item')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = ticked.has(k)
      cb.disabled = ro
      cb.dataset.k = k
      cb.addEventListener('change', () => {
        if (cb.checked) ticked.add(k); else ticked.delete(k)
        const keep = all.values.filter((x) => ticked.has(matchKey(x)))
        // EVERYTHING TICKED IS "(All)", spelled by the absent predicate — not a
        // list of today's values, which would silently exclude every value a
        // later edit adds to the column.
        commit(setFilterValues(spec, col, keep.length === all.values.length && !all.truncated ? null : keep))
      })
      row.append(cb, el('span', '', k === BLANK_KEY ? t('(Blanks)') : listLabel(v, column)))
      box.append(row)
    }
    if (all.truncated) {
      box.append(el('div', 'dpf-note', t('Only the first {n} values are listed.', { n: FILTER_CAP })))
    }
    return box
  }

  function startDrag(e: DragEvent, p: DragPayload): void {
    if (ro || !e.dataTransfer) return
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(p))
    e.dataTransfer.effectAllowed = 'move'
  }
}

/** Accept a dragged field. Only ours: anything else dragged over is ignored. */
function dropTarget(target: HTMLElement, onDrop: (p: DragPayload, e: DragEvent) => void): void {
  target.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    target.classList.add('dpf-over')
  })
  target.addEventListener('dragleave', (e) => {
    if (!target.contains(e.relatedTarget as Node | null)) target.classList.remove('dpf-over')
  })
  target.addEventListener('drop', (e) => {
    target.classList.remove('dpf-over')
    const raw = e.dataTransfer?.getData(DRAG_TYPE)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    let p: DragPayload
    try { p = JSON.parse(raw) as DragPayload } catch { return }
    if (!p || typeof p.col !== 'string') return
    onDrop(p, e)
  })
}

/** Where in a well a drop at `y` lands: before the first chip whose middle is
 *  below the pointer. */
function dropIndex(well: HTMLElement, y: number): number {
  const chips = [...well.querySelectorAll<HTMLElement>(':scope > .dpf-chip')]
  for (let i = 0; i < chips.length; i++) {
    const r = chips[i].getBoundingClientRect()
    if (y < r.top + r.height / 2) return i
  }
  return chips.length
}
