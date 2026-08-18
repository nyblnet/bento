// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The About surface: what this file is, updating it, its language, its
// password, and the ways out of it.
//
// PLATFORM §10 requires a signed self-update path, an encryption story and an
// AI round-trip. All three live behind one button, because a self-contained
// document has nowhere else to put them.

import { checkForUpdates, applyUpdate, APP_VERSION, type ReleaseInfo } from '../../kernel/src/update.ts'
import {
  setEncryptionPassword, isEncryptionActive,
  canWriteInPlace, openedFileName,
} from '../../kernel/src/save.ts'
import { clearVersions, clearRecovery } from '../../kernel/src/autosave.ts'
import { t, localeChoices, locale, setLocale } from './i18n'
import { inertBody, esc } from './sanitize'
import { SPEC, mdLayout } from './blocks'
import type { Store } from './store'

export interface AboutHooks {
  store: Store
  onRepaint: () => void
  /**
   * "Save a copy…", supplied by the caller.
   *
   * NOT saveFile(doc, true) here. That path assigns the picked handle to the
   * kernel's in-place handle, so every later ⌘S writes to the copy — the bug
   * fixed in the topbar's copy button, which this second button then kept
   * alive because the guard only read main.ts. One implementation, two
   * buttons, and the assertion now reads every file.
   */
  onSaveCopy: () => void
  /** open the markdown importer — the way IN, opposite the ways out below */
  onImport?: () => void
}

export function openAbout({ store, onRepaint, onSaveCopy, onImport }: AboutHooks): void {
  const back = document.createElement('div')
  back.className = 'sp-overlay'
  const card = document.createElement('div')
  card.className = 'sp-card sp-about'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', t('About this space'))
  const close = () => back.remove()

  const h = (text: string) => {
    const n = document.createElement('h2')
    n.className = 'sp-card-h'
    n.textContent = text
    return n
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
    `<span>v${APP_VERSION} · ${esc(t('format v{v}', { v: String(store.doc.version ?? 1) }))}</span></div></a>`
  head.querySelector('a')?.setAttribute('title', t('Visit bento.page (opens in a new tab)'))
  card.append(head)

  card.append(h(t('This file')))
  const blurb = document.createElement('p')
  blurb.className = 'sp-about-blurb'
  const pages = store.doc.pages.length
  const blocks = store.doc.pages.reduce((n, p) => n + p.blocks.length, 0)
  blurb.textContent = t(
    'bento/spaces {version} · {pages} page(s), {blocks} block(s). The document, the editor and the search are all in this one file.',
    { version: APP_VERSION, pages, blocks },
  )
  card.append(blurb)

  const fileName = openedFileName()
  if (fileName) card.append(row(t('File'), text(fileName)))
  if (!canWriteInPlace()) {
    const note = document.createElement('p')
    note.className = 'sp-note'
    // stated up front rather than discovered on the first save
    note.textContent = t('This browser cannot write back to the file, so every save makes a new copy. Chrome and Edge on a computer can save in place.')
    card.append(note)
  }

  // ---- updates -----------------------------------------------------------
  card.append(h(t('Updates')))
  const upStatus = document.createElement('p')
  upStatus.className = 'sp-note'
  upStatus.textContent = t('Checking is manual and verified: the download is signed, and its signature is checked against a key inside this file before anything is rewritten.')
  card.append(upStatus)

  const checkBtn = button(t('Check for updates'), async () => {
    upStatus.textContent = t('Checking…')
    let res: Awaited<ReturnType<typeof checkForUpdates>>
    try { res = await checkForUpdates() } catch { upStatus.textContent = t('Could not reach the update channel.'); return }
    if (res.status === 'current') { upStatus.textContent = t('You have the newest version ({v}).', { v: APP_VERSION }); return }
    if (res.status !== 'update') { upStatus.textContent = t('Could not verify an update, so nothing was changed.'); return }
    const rel: ReleaseInfo = res.release
    upStatus.textContent = t('Version {v} is available.', { v: rel.version })
    const apply = button(t('Update this file'), async () => {
      // the update writes a NEW file and leaves this one untouched, so a bad
      // update is undone by deleting the download
      await applyUpdate(rel, store.doc)
      upStatus.textContent = t('Downloaded. Open the new file — this one is unchanged.')
    }, true)
    card.insertBefore(apply, upStatus.nextSibling)
  })
  card.append(checkBtn)

  // ---- language ----------------------------------------------------------
  card.append(h(t('Language')))
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
  card.append(row(t('Interface language'), sel))
  const langNote = document.createElement('p')
  langNote.className = 'sp-note'
  // the same rule as slides: language follows the READER, never the document
  langNote.textContent = t('Language follows whoever opens the file. It is never written into the document.')
  card.append(langNote)

  // ---- password ----------------------------------------------------------
  card.append(h(t('Password')))
  const pwNote = document.createElement('p')
  pwNote.className = 'sp-note'
  pwNote.textContent = isEncryptionActive()
    ? t('This space is encrypted. Saves stay encrypted.')
    : t('A password encrypts the document inside the file. There is no recovery — lose it and the space is gone.')
  card.append(pwNote)

  card.append(button(isEncryptionActive() ? t('Remove password…') : t('Set a password…'), async () => {
    if (isEncryptionActive()) {
      if (!confirm(t('Remove the password? The next save writes the document in the clear.'))) return
      setEncryptionPassword(null)
      pwNote.textContent = t('Password removed. Save to write the space unencrypted.')
      return
    }
    const pw = prompt(t('Choose a password. There is no way to recover it.'))
    if (!pw) return
    setEncryptionPassword(pw)
    // Plaintext snapshots written BEFORE encryption was turned on would defeat
    // the encryption the author just enabled. Both stores: the version timeline
    // and the single recovery snapshot. From here on main.ts writes neither.
    await clearVersions(store.doc.docId)
    await clearRecovery(store.doc.docId)
    pwNote.textContent = t('Password set. Save to write the space encrypted.')
  }))

  // ---- the way in ---------------------------------------------------------
  // Beside the ways out on purpose: a format that can only be left is a
  // format nobody arrives in.
  if (onImport) {
    card.append(h(t('Bring notes in')))
    card.append(button(t('Import Markdown…'), () => { close(); onImport() }))
    const inNote = document.createElement('p')
    inNote.className = 'sp-note'
    inNote.textContent = t('A folder of .md files becomes pages, with the folder tree and the [[wikilinks]] intact.')
    card.append(inNote)
  }

  // ---- ways out ----------------------------------------------------------
  card.append(h(t('Take it elsewhere')))
  const exports = document.createElement('div')
  exports.className = 'sp-actions'
  exports.append(
    button(t('Copy document JSON'), () => {
      void navigator.clipboard?.writeText(JSON.stringify(store.doc, null, 2))
    }),
    button(t('Export as Markdown'), () => downloadMarkdown(store)),
    button(t('Save a copy…'), () => { close(); onSaveCopy() }),
  )
  card.append(exports)
  const outNote = document.createElement('p')
  outNote.className = 'sp-note'
  outNote.textContent = t('A space is never a dead end: the whole document is plain JSON in this file, and every page exports as Markdown.')
  card.append(outNote)

  card.append(button(t('Close'), close, true))

  back.append(card)
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  document.body.append(back)
  card.querySelector('button')?.focus()

  function text(s: string): HTMLElement {
    const n = document.createElement('span')
    n.className = 'sp-mono'
    n.textContent = s
    return n
  }
}

/**
 * Every page as one Markdown file.
 *
 * The renderer already emits semantic tags, so the mapping is direct — which
 * is the payoff for having refused divs-with-classes in the first place.
 */
export function toMarkdown(store: Store): string {
  const out: string[] = []
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
        const lines = spec?.toMd
          ? spec.toMd(b, text, indent, (id) => store.index.page.get(id)?.title)
          : [text]
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

/** Inline html → inline markdown. Links become `[text](#p/id)` so a reader can
 *  still see which page was meant even outside the space. */
function htmlToMd(html: string): string {
  // INERT parse — exporting must not run what it is exporting. A detached div
  // still loads its own resources, so `<img src="404" onerror>` in a block
  // would fire on "Download as Markdown". See sanitize.ts inertBody().
  const d = inertBody(html)
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? ''
    if (!(n instanceof HTMLElement)) return ''
    const inner = [...n.childNodes].map(walk).join('')
    switch (n.tagName) {
      case 'B': case 'STRONG': return `**${inner}**`
      case 'I': case 'EM': return `*${inner}*`
      case 'CODE': return `\`${inner}\``
      case 'S': return `~~${inner}~~`
      case 'BR': return '\n'
      case 'A': return `[${inner}](${n.getAttribute('href') ?? ''})`
      default: return inner
    }
  }
  return [...d.childNodes].map(walk).join('').trim()
}

export function downloadMarkdown(store: Store): void {
  const blob = new Blob([toMarkdown(store)], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(store.doc.title || 'space').replace(/[^\w.-]+/g, '-')}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}
