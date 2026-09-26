// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The About surface: what this file is, what is in it, updating it, its
// language, its password, and the ways in and out of it.
//
// PLATFORM §10 requires a signed self-update path, an encryption story and an
// AI round-trip. All three live behind one button, because a self-contained
// document has nowhere else to put them.
//
// BUILT FROM SLIDES' DIALOG, deliberately. Two apps in one suite must not
// teach two different dialogs: same opening mark, same section order (what
// this is → what is in it → updates → viewer preferences → the document →
// the ways out), same register, same restraint. What differs is only what the
// app IS — a space is measured in pages, blocks and words where a deck is
// measured in slides.
//
// TWO LAYOUT RULES THIS DIALOG LIVES UNDER (CLAUDE.md, hard-won #9 and #10):
//   · The card SCROLLS (`overflow: auto`), and `overflow-y: auto` clips
//     HORIZONTALLY too — there is no such thing as scrolling one axis while
//     the other overflows visibly. So nothing in here may be a floating
//     popover: everything that opens (the update card, the replace-from-JSON
//     panel, every confirmation) opens IN FLOW as a block of the list, and the
//     card scrolls to it. A 250px popover anchored inside a scrolling menu is
//     the bug that cost this project a day in slides' phone chrome.
//   · The kernel dialog's scrim carries a z-index (1000, above every menu),
//     and that is a CEILING on every descendant rather than merely an order.
//     Nothing in this dialog tries to escape it, and nothing added later can
//     be made to by raising its own z-index.

import {
  checkForUpdates, applyUpdate, applyUpdateInPlace, canUpdateInPlace,
  autoCheckEnabled, setAutoCheck, compareVersions,
  APP_VERSION, type ReleaseInfo, type UpdateCheck,
} from '../../kernel/src/update.ts'
import {
  canWriteInPlace, openedFileName,
} from '../../kernel/src/save.ts'
import { createDialog, type Dialog } from '../../kernel/src/ui/dialog.ts'
import '../../kernel/src/ui/dialog.css'
import { t, localeChoices, locale, setLocale } from './i18n'
import { appearanceSection } from './appearance'
import { esc, textOf } from './sanitize'
import { htmlToMd } from './marks.ts'
import { humanBytes } from './assets'
import { SPEC, mdLayout, type MdCtx } from './blocks'
import {
  issuesOf, passesFilter, sortRows, fieldByKey, optionOf, fieldsOf,
} from './fields'
import type { Store } from './store'
import type { Block, SpacesDoc } from './model'

export interface AboutHooks {
  store: Store
  onRepaint: () => void
  /** the editor's status line, for the confirmations that outlive the dialog */
  onStatus?: (message: string) => void
  /** open on a fresh update check — the update chip's click, as in slides */
  runCheck?: boolean
}

/**
 * The launch check's result, for the line the dialog opens on.
 *
 * Module-level and not in the doc: whether this READER checked for updates is
 * no business of the document, exactly as the locale is not.
 */
let lastAutoCheck: UpdateCheck | null = null

/**
 * Check at launch, if the reader left that on.
 *
 * The preference (`bento-auto-check`, kernel/src/update.ts) is the one slides
 * uses, so a person who turned it off in one app has turned it off in both.
 * Nothing about the reader or the document goes out with the request — it is a
 * plain GET of a signed manifest — and the dialog says so where the switch is.
 */
export async function launchUpdateCheck(): Promise<UpdateCheck | null> {
  if (!autoCheckEnabled()) return null
  lastAutoCheck = await checkForUpdates()
  return lastAutoCheck
}

export function openAbout(hooks: AboutHooks): void {
  const { store, onRepaint } = hooks
  const doc = store.doc

  // THE KERNEL'S DIALOG (kernel/src/ui/dialog.ts) is the shell; `card` is its
  // content. The primitive took the three things this file used to hand-roll —
  // a capture-phase document Escape (a <select> steals focus, so an Escape on
  // the card itself stopped working), the Tab trap, focus returned to the
  // opener — and adds the scrim above every menu. No visible title, as in
  // slides: the suite's lockup below IS the heading, and the dialog is named
  // for a screen reader instead.
  const card = document.createElement('div')
  card.className = 'sp-about'
  let dlg: Dialog | null = null
  const close = () => dlg?.close()

  // ---- small builders ----------------------------------------------------
  const h = (text: string) => {
    const n = document.createElement('h2')
    n.className = 'sp-card-h'
    n.textContent = text
    return n
  }
  /** A section with a real heading, not one more control in a flat stack. */
  const section = (title: string, ...kids: Array<Node | null>) => {
    const s = document.createElement('section')
    s.className = 'sp-ab-sec'
    s.append(h(title))
    for (const k of kids) if (k) s.append(k)
    card.append(s)
    return s
  }
  const note = (text: string, cls = '') => {
    const p = document.createElement('p')
    p.className = 'sp-note' + (cls ? ' ' + cls : '')
    p.textContent = text
    return p
  }
  const row = (label: string, node: HTMLElement) => {
    const r = document.createElement('div')
    r.className = 'sp-row'
    const s = document.createElement('span')
    s.textContent = label
    r.append(s, node)
    return r
  }
  const button = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button')
    b.className = 'sp-btn' + (primary ? ' sp-primary' : '')
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
  const actions = (...kids: HTMLElement[]) => {
    const d = document.createElement('div')
    d.className = 'sp-actions'
    d.append(...kids)
    return d
  }
  const mono = (s: string) => {
    const n = document.createElement('span')
    n.className = 'sp-mono'
    n.textContent = s
    return n
  }
  const check = (label: string, on: boolean, fn: (v: boolean) => void) => {
    const l = document.createElement('label')
    l.className = 'sp-ab-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = on
    cb.addEventListener('change', () => fn(cb.checked))
    l.append(cb, document.createTextNode(' ' + label))
    return l
  }

  // ---- what this is ------------------------------------------------------
  // The same head slides uses: the suite's mark, the app, the version, and a
  // gentle route back to the site. A dialog that opens with a section heading
  // does not tell you what you are looking at.
  const head = document.createElement('div')
  head.className = 'sp-about-head'
  head.innerHTML =
    '<a class="sp-about-logo" href="https://bento.page" target="_blank" rel="noopener">' +
    '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">' +
    '<rect width="32" height="32" rx="7" fill="#16273E"/>' +
    '<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>' +
    '<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>' +
    '<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>' +
    '</svg><div><b>bento<span style="color:#FF9E8A">/</span>spaces</b>' +
    `<span>v${esc(APP_VERSION)} · ${esc(t('format v{v}', { v: String(doc.version ?? 1) }))}</span></div></a>`
  head.querySelector('a')?.setAttribute('title', t('Visit bento.page (opens in a new tab)'))
  card.append(head)

  const promo = document.createElement('p')
  promo.className = 'sp-ab-promo'
  // The one innerHTML with markup in it, and the markup is OURS: two anchors
  // built here and interpolated into a translated sentence. Nothing from the
  // document, the network or a catalog's placeholder value reaches it.
  promo.innerHTML = t(
    'New to Bento? Find templates, the gallery and the AI editing guide at {home} — or ⭐ it on {gh}.',
    {
      home: '<a href="https://bento.page" target="_blank" rel="noopener">bento.page</a>',
      gh: '<a href="https://github.com/nyblnet/bento" target="_blank" rel="noopener">GitHub</a>',
    },
  )
  card.append(promo)

  // ---- what is in it -----------------------------------------------------
  // The numbers a person actually wants, and then the one that explains the
  // others: where the weight is. A space is big because of its images, always,
  // and a readout that says "4.2 MB" without saying that has told you nothing
  // you can act on.
  const pages = doc.pages.length
  const blocks = doc.pages.reduce((n, p) => n + p.blocks.length, 0)
  let words = 0
  for (const p of doc.pages) {
    words += countWords(p.title)
    for (const b of p.blocks) words += countWords(textOf(b.html))
  }
  const assetBytes = Object.values(doc.assets ?? {}).reduce((n, v) => n + v.length, 0)
  const assetCount = Object.keys(doc.assets ?? {}).length
  const docBytes = byteLength(doc)

  const stats = document.createElement('div')
  stats.className = 'sp-ab-stats'
  for (const [value, label] of [
    [String(pages), t('Pages')],
    [String(blocks), t('Blocks')],
    [String(words), t('Words')],
    [humanBytes(docBytes), t('Document')],
  ] as Array<[string, string]>) {
    const s = document.createElement('div')
    s.className = 'sp-ab-stat'
    const b = document.createElement('b')
    b.textContent = value
    const l = document.createElement('span')
    l.textContent = label
    s.append(b, l)
    stats.append(s)
  }

  const weight = note(
    assetCount
      ? t('{n} embedded image(s) and clip(s) account for {size} of that — {pct}%. Everything else is text.', {
        n: assetCount, size: humanBytes(assetBytes),
        pct: docBytes ? Math.round((assetBytes / docBytes) * 100) : 0,
      })
      : t('All text. Nothing is embedded, so this file is as small as a space gets.'),
  )
  const fileName = openedFileName()
  const sec1 = section(t('This file'), stats, weight)
  if (fileName) sec1.append(row(t('File'), mono(fileName)))
  sec1.append(note(t('The document, the editor and the search are all in this one file. Opening it needs nothing else — no server, no account, no install.')))
  if (!canWriteInPlace()) {
    // stated up front rather than discovered on the first save
    sec1.append(note(t('This browser cannot write back to the file, so every save makes a new copy. Chrome and Edge on a computer can save in place.')))
  }

  // ---- the document itself ------------------------------------------------
  // Its name is the one property of a space anybody edits here; the rest are
  // facts about it, shown because a file you cannot identify is a file you
  // cannot support.
  const titleIn = document.createElement('input')
  titleIn.type = 'text'
  titleIn.className = 'sp-input'
  titleIn.value = doc.title
  titleIn.disabled = store.readOnly
  titleIn.addEventListener('change', () => {
    const next = titleIn.value.trim() || 'Untitled'
    titleIn.value = next
    store.runEdit('__title', () => { store.doc.title = next })
    onRepaint()
  })
  const props = section(t('Document properties'))
  const titleRow = document.createElement('div')
  titleRow.className = 'sp-ab-field'
  const titleLbl = document.createElement('label')
  titleLbl.textContent = t('Title')
  titleRow.append(titleLbl, titleIn)
  props.append(titleRow)
  props.append(row(t('Document id'), mono(doc.docId)))
  if (doc.modified) props.append(row(t('Last saved'), mono(shortStamp(doc.modified))))

  // ---- updates -----------------------------------------------------------
  const upSec = section(t('Updates'))
  const upStatus = document.createElement('div')
  upStatus.className = 'sp-ab-status'
  const upLine = document.createElement('p')
  upLine.className = 'sp-note'
  upStatus.append(upLine)
  upLine.textContent =
    lastAutoCheck?.status === 'current'
      ? t("Checked automatically at launch — you're on the latest version (v{v}).", { v: APP_VERSION })
      : lastAutoCheck?.status === 'error'
        ? t("Launch check couldn't reach the release server ({m}). Check manually below.", { m: lastAutoCheck.message })
        : t('This file carries its own app — it works offline, forever, as is.')

  const checkBtn = button(t('Check for updates'), () => { void runCheck() })
  upSec.append(actions(checkBtn), upStatus)
  upSec.append(check(t('Check for updates automatically at launch'), autoCheckEnabled(), (on) => setAutoCheck(on)))
  upSec.append(note(t('An update check is the only network this app makes on its own. It asks the release server for a signed manifest and sends nothing about you or this document — no ids, no telemetry.')))

  async function runCheck(): Promise<void> {
    checkBtn.disabled = true
    upStatus.textContent = ''
    upStatus.append(upLine)
    upLine.textContent = t('Checking…')
    const res = await checkForUpdates()
    lastAutoCheck = res
    checkBtn.disabled = false
    if (res.status === 'current') {
      upLine.textContent = t('You have the newest version ({v}).', { v: APP_VERSION })
      return
    }
    if (res.status === 'error') {
      upLine.textContent = t('Could not reach the update channel.')
      return
    }
    upLine.textContent = ''
    upStatus.append(updateCard(res.release))
  }

  /**
   * One card for the one moment in this dialog with a decision in it.
   *
   * Grouped rather than left as five loose children of the status block — the
   * layout lesson slides paid for, where a heading, the notes and three
   * buttons squeezed between the section above and the controls below and a
   * five-bullet changelog read as one line plus two scrollbars.
   */
  function updateCard(rel: ReleaseInfo): HTMLElement {
    const box = document.createElement('div')
    box.className = 'sp-ab-update'
    const line = document.createElement('div')
    line.className = 'sp-ab-new'
    line.textContent = t('Version {v} is available.', { v: rel.version })
    box.append(line)

    // Per-version notes filtered to what THIS file actually skipped: a reader
    // two versions behind should see both, and one version behind should not
    // see the older one again. `notes` is the fallback for a manifest that
    // predates the field.
    const skipped = rel.notesFrom
      ? Object.keys(rel.notesFrom)
        .filter((v) => compareVersions(v, APP_VERSION) > 0)
        .sort((a, b) => compareVersions(b, a))
      : []
    if (skipped.length) {
      const lines = skipped.flatMap((v) =>
        (rel.notesFrom![v] ?? []).map((n) => (skipped.length > 1 ? `• ${n}  (${v})` : `• ${n}`)))
      box.append(releaseNotes(lines.join('\n')))
    } else if (rel.notes) {
      box.append(releaseNotes(rel.notes))
    }

    const link = document.createElement('a')
    link.className = 'sp-btn sp-ab-link'
    link.href = `https://github.com/nyblnet/bento/releases/tag/v${encodeURIComponent(rel.version)}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = t('What’s new →')
    link.title = t('Read the release notes for v{v} (opens in a new tab)', { v: rel.version })

    const inPlace = button(canUpdateInPlace() ? t('Update this file') : t('Update this file…'), () => {
      void (async () => {
        inPlace.disabled = true
        inPlace.textContent = t('Verifying…')
        try {
          const written = await applyUpdateInPlace(rel, store.doc)
          if (written) {
            box.replaceChildren(updatedCard(rel, written.backup))
          } else {
            inPlace.disabled = false
            inPlace.textContent = t('Update this file…')
          }
        } catch (err) {
          inPlace.disabled = false
          inPlace.textContent = t('Update this file…')
          upLine.textContent = t('Update failed: {m}', { m: String((err as Error)?.message ?? err) })
        }
      })()
    }, true)
    inPlace.title = canUpdateInPlace()
      ? t('Downloads a backup of the current version, then rewrites this file on disk as the new version — document untouched.')
      : t('Verifies and builds the new version with this document inside, then asks where to save it — pick the file you have open to update it.')

    const get = button(t('Download updated copy'), () => {
      void (async () => {
        get.disabled = true
        get.textContent = t('Verifying…')
        try {
          // the update writes a NEW file and leaves this one untouched, so a
          // bad update is undone by deleting the download
          await applyUpdate(rel, store.doc)
          get.textContent = t('Downloaded ✓')
          box.append(note(t('This window keeps running v{v} until you open the downloaded file.', { v: APP_VERSION })))
        } catch (err) {
          get.disabled = false
          get.textContent = t('Download updated copy')
          upLine.textContent = t('Update failed: {m}', { m: String((err as Error)?.message ?? err) })
        }
      })()
    })

    box.append(actions(link, inPlace, get))
    return box
  }

  function updatedCard(rel: ReleaseInfo, backup: 'beside' | 'downloaded' | 'none'): HTMLElement {
    const done = document.createElement('div')
    done.className = 'sp-ab-update'
    const ok = document.createElement('div')
    ok.className = 'sp-ab-new'
    ok.textContent = t('Updated to v{v} on disk.', { v: rel.version })
    done.append(ok)
    // Say where the rollback went. A backup nobody can find is not a backup.
    done.append(note(
      backup === 'beside'
        ? t('This window is still running v{v} — reload to finish. A v{v} backup was saved beside this file.', { v: APP_VERSION })
        : backup === 'downloaded'
          ? t('This window is still running v{v} — reload to finish. A v{v} backup was downloaded.', { v: APP_VERSION })
          : t("This window is still running v{v}. If you overwrote the file that's open here, reload; otherwise open the file you saved.", { v: APP_VERSION }),
    ))
    done.append(actions(button(t('Reload into new version'), () => {
      store.dirty = false // disk already holds this exact document
      location.reload()
    }, true)))
    return done
  }

  // ---- appearance --------------------------------------------------------
  // Beside Language, because they are the same kind of thing: preferences that
  // belong to whoever opened the file, not to the file.
  card.append(...appearanceSection())

  // ---- language ----------------------------------------------------------
  const sel = document.createElement('select')
  sel.className = 'sp-select'
  for (const c of localeChoices()) {
    const o = document.createElement('option')
    o.value = c.code
    o.textContent = c.label
    if (c.code === locale()) o.selected = true
    sel.append(o)
  }
  sel.addEventListener('change', () => {
    setLocale(sel.value)
    close()
    onRepaint()
  })
  section(
    t('Language'),
    row(t('Interface language'), sel),
    // the same rule as slides: language follows the READER, never the document
    note(t('Language follows whoever opens the file. It is never written into the document.')),
  )

  // ---- this file, and the document -------------------------------------
  // After the viewer's preferences, as slides orders its About: what the app
  // is and whether it is current first, then how YOU see it, then the file.
  // (Password, history, the JSON round trip, import and the ways out are the
  // document's own commands and live under Save ▾ now — doccmds.ts.)
  card.append(sec1, props)

  // ---- fine print ---------------------------------------------------------
  const fine = document.createElement('p')
  fine.className = 'sp-ab-fine'
  fine.textContent = t('bento/spaces is MIT-licensed and carries no third-party runtime — the full notices travel in this file’s source.')
  card.append(fine)

  const foot = document.createElement('div')
  foot.className = 'sp-ab-foot'
  foot.append(button(t('Close'), close, true))
  card.append(foot)

  dlg = createDialog({ label: t('About this space'), content: card })
  dlg.card.classList.add('sp-dlg', 'sp-dlg-about')
  dlg.open()
  // the one control the dialog opens FOR, not the logo link the trap would pick
  checkBtn.focus()
  // the chip means "there is an update": show it, as slides' About does
  if (hooks.runCheck || lastAutoCheck?.status === 'update') void runCheck()
}

/**
 * Release notes → a real list.
 *
 * The manifest carries them as PLAIN TEXT, one "• " bullet per line, capped at
 * five plus an "…and N more" tail (scripts/release.mjs). A pre-wrap block gave
 * every wrapped bullet a flush-left second line, which at 375px is most of them
 * — so one item read as two and the box looked like a wall. Split per line and
 * hang the indent instead.
 *
 * Always textContent, never innerHTML: the manifest is signed, but a signature
 * says who wrote a string, not that it is safe to run.
 */
function releaseNotes(notes: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-ab-release'
  for (const raw of notes.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const bullet = /^[•*-]\s+/.test(text)
    const item = document.createElement('div')
    item.className = bullet ? 'sp-ab-note' : 'sp-ab-more'
    item.textContent = bullet ? text.replace(/^[•*-]\s+/, '') : text
    box.append(item)
  }
  return box
}

/**
 * Words, in a way that is not wrong outside Europe.
 *
 * Splitting on whitespace counts a whole Japanese paragraph as one word. CJK
 * has no inter-word space, so its characters are counted individually — the
 * convention every word processor uses — and the rest splits on whitespace.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g
function countWords(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.replace(CJK, ' ').trim()
  return cjk + (rest ? rest.split(/\s+/).length : 0)
}

/** Real UTF-8 bytes of the document, not characters — MB is a promise. */
function byteLength(doc: SpacesDoc): number {
  const json = JSON.stringify(doc)
  try { return new Blob([json]).size } catch { return json.length }
}

/** A timestamp a person can read, in the reader's own locale. */
function shortStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return d.toISOString().slice(0, 16).replace('T', ' ') }
}

/**
 * Every page as one Markdown file.
 *
 * The renderer already emits semantic tags, so the mapping is direct — which
 * is the payoff for having refused divs-with-classes in the first place.
 */
export function toMarkdown(store: Store): string {
  const out: string[] = []
  const ctx: MdCtx = {
    titleOf: (id) => store.index.page.get(id)?.title,
    // THE SAME converter every other block's text goes through, handed to the
    // one type whose text is not a single string. A table with its own inline
    // rules would be the second place `**bold**` is decided.
    inline: htmlToMd,
    // DERIVED THE SAME WAY THE SCREEN DERIVES IT — same filter, same sort, same
    // grouping — so the file you download is the board you were looking at. A
    // second traversal here is how an export starts quietly disagreeing with
    // the app.
    rowsOf: (b: Block) => {
      const doc = store.doc
      const groupKey = String((b as { groupBy?: unknown }).groupBy ?? 'status')
      const grouped = String((b as { layout?: unknown }).layout ?? 'board') !== 'list'
      const field = fieldByKey(doc, groupKey)
      const rows = sortRows(
        doc,
        issuesOf(doc).filter((r) => passesFilter(doc, r.values, (b as { filter?: unknown }).filter)),
        (b as { sort?: unknown }).sort)
      // the board's column order, so an export reads top-to-bottom the way the
      // board reads left-to-right
      const order = new Map((field?.options ?? []).map((o, i) => [o.id, i]))
      const seat = (r: (typeof rows)[number]) =>
        order.get(String(r.values.get(groupKey) ?? '')) ?? Number.MAX_SAFE_INTEGER
      const ordered = grouped
        ? rows.map((r, i) => ({ r, i })).sort((a, c) => (seat(a.r) - seat(c.r)) || (a.i - c.i)).map((x) => x.r)
        : rows
      return ordered.map((r) => ({
        id: r.page.id,
        title: r.page.title,
        group: grouped
          ? (optionOf(field, r.values.get(groupKey))?.label ?? t('Other'))
          : undefined,
        // the same chips the card shows, in the same words
        fields: fieldsOf(doc)
          .filter((f) => f.key !== groupKey)
          .map((f) => {
            const v = r.values.get(f.key)
            if (v === undefined || v === null || v === '') return ''
            return optionOf(f, v)?.label ?? (Array.isArray(v) ? v.join(', ') : String(v))
          })
          .filter(Boolean).join(' · '),
      }))
    },
  }
  // ONE traversal, store.tree() — not a second walk over index.children.
  // That second walk is how a page-tree CYCLE dropped pages out of the export
  // while they sat in the file: neither page is reachable from the root, so
  // neither was ever visited. Store.tree() carries the visited set and surfaces
  // what a cycle orphans, and this now inherits both. Measured before the fix:
  // 13 pages in the file, 11 in the export.
  const walk = () => {
    for (const { page, depth } of store.tree()) {
      out.push(`${'#'.repeat(Math.min(depth + 1, 6))} ${page.title}`, '')
      // Indent, blockquote markers and what separates one block from the next
      // are properties of the TREE, not of a block, so they come from the
      // registry in one pass (blocks.ts mdLayout).
      const layout = mdLayout(page.blocks)
      page.blocks.forEach((b, i) => {
        const { quote, indent, sep } = layout[i]
        const text = htmlToMd(b.html ?? '')
        // From the block registry, so a new type exports correctly the moment
        // it is declared. An UNKNOWN type — a file written by a newer build —
        // falls through to its text, which is the honest default.
        const spec = SPEC.get(b.type)
        const lines = spec?.toMd ? spec.toMd(b, text, indent, ctx) : [text]
        // PER LINE, not per returned element. A spec returns ELEMENTS, and an
        // element can hold newlines: a code block's body is one multi-line
        // string, and htmlToMd turns <br> into a newline in ordinary text. Any
        // such child inside a callout left its 2nd..nth lines unquoted, which
        // ENDS the blockquote — the GitHub alert stops there, a nested fence is
        // left unterminated, and the rest of the callout falls out of the box
        // as broken prose. The callout's own toMd split on \n; nothing else did.
        //
        // An empty line inside a quote must be a bare '>', never '> ' and never
        // blank: a blank line closes the blockquote.
        out.push(...lines.flatMap((l) => l.split('\n')).map((l) => (l ? quote + l : quote.trimEnd())))
        out.push(sep)
      })
    }
  }
  walk()
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Inline html → inline markdown.
 *
 * Lives in marks.ts now, with the mark table it has to agree with. It used to
 * be a DOM walk here, which meant it could not be tested — the rigs are plain
 * node — so "does every mark survive an export" was a question only a human
 * with a browser could answer. Four of them did not: `u`, `mark`, `sub` and
 * `sup` fell through to their text. It is a pure function over the same run
 * list the canonicaliser uses, so a mark the model can hold and the exporter
 * cannot spell is now a rig failure.
 */

export function downloadMarkdown(store: Store): void {
  const blob = new Blob([toMarkdown(store)], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(store.doc.title || 'space').replace(/[^\w.-]+/g, '-')}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}
