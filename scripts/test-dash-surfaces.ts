#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash's two dialog surfaces — the split, and the size of each half.
//
//   node scripts/test-dash-surfaces.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES, AND WHY IT IS A RIG RATHER THAN A LOOK.
//
// There used to be ONE dialog behind the ⓘ button, and everything that had
// nowhere else to go went into it: what this file is · document properties ·
// updates · language · appearance · password · version history · take it
// elsewhere. Eight sections, 260 words, and — measured in the running app —
// 1361px tall in a 429px viewport. Three and a bit screens. Nothing in it was
// wrong; they were simply not one thing, and the reader who came to find out
// what language the interface is in scrolled past their own password.
//
// A dialog does not get to that size in one commit. It gets there one
// reasonable addition at a time, each of which is obviously fine, and there is
// no moment at which anybody decides to ship three screens of scroll. That is
// what a rig is for: this one holds the SEAM (which surface a thing belongs to)
// and the SIZE (each surface fits a laptop screen without scrolling), so the
// next reasonable addition has to answer both questions before it lands.
//
// THE SEAM. Language, theme and the update check follow the READER and are kept
// in this browser, never in the file (PLATFORM §8, and the same rule slides
// applies to reduced motion). Everything else here travels IN the workbook. So
// there are exactly two surfaces and one menu:
//
//   Settings  — language, appearance, updates, offline. Yours.
//   About     — identity, properties, version history, the document as JSON.
//               The file's.
//   Save ▾    — the password, beside the other instructions about how this
//               workbook gets written (template, read-only copy, fork).
//
// Below, each is checked to hold its own and NONE of the others': a document
// field in Settings or a preference in About is the drift that produced the
// original, and it is caught here on the day it is written.
//
// HOW THE HEIGHT IS MEASURED. There is no browser in a rig, so the dialogs are
// mounted into scripts/lib/dash-dom.ts and run through a box model of
// about.css written out below — margins (collapsed, as a browser collapses
// them), padding, borders, line heights, and a character-width estimate for
// wrapping. That model is CALIBRATED against the one number measured in the
// real app: at a 429px viewport it puts the original eight-section dialog at
// 1380px against the 1361px measured, 1.4% high. It is an estimate and it says
// so; what it is good for is exactly what it is used for — refusing a surface
// that has grown by hundreds of pixels, which is the only way this failure has
// ever actually happened.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// The modules import their own stylesheets — Vite's job, and a file extension
// Node refuses outright.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const g = globalThis as unknown as Record<string, unknown>
// `openedFileName()` reads the URL when there is no File System Access handle,
// and `canWriteInPlace()` asks the window for the picker. Both are the ordinary
// desktop-Chrome answers, which is the case being sized.
g.location = { href: 'https://example.test/Quarterly%20plan.bento.html' }
g.window = { showSaveFilePicker: () => {} }

const { installDom } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El
const { doc } = installDom()

const about = await import('../dash/src/about.ts')
const settings = await import('../dash/src/settings.ts')
const { parseDoc } = await import('../dash/src/model.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const src = (rel: string) => readFileSync(new URL(`../dash/src/${rel}`, import.meta.url), 'utf8')

// --------------------------------------------------------------- the box model
//
// about.css, as arithmetic. Every number here is a declaration in that file and
// nothing else; if a rule changes, this changes with it.

const CHAR = (fs: number) => fs * 0.5          // average glyph, UI sans, Latin
const BTN_H = 29.8                             // .dx-btn: 13px/normal + 6px+6px + 2 borders
const BTN_W = (label: string) => label.length * CHAR(13) + 20
const VERS_CAP = 88                            // .dx-about-vers max-height: 5.5rem

const lineCount = (text: string, fs: number, avail: number): number =>
  Math.max(1, Math.ceil((text.length * CHAR(fs)) / Math.max(1, avail)))

interface Box { mt: number; h: number; mb: number }

function boxOf(el: El, width: number, first: boolean): Box {
  const cls = el.className || ''
  const has = (c: string) => cls.split(/\s+/).includes(c)
  const text = el.textContent

  if (el.tagName === 'H2') {                                   // margin: 14px 0 6px
    return { mt: first ? 0 : 14, h: 11 * 1.45 * lineCount(text, 11, width), mb: 6 }
  }
  if (has('dx-about-lede')) {                                  // margin: 0 0 8px
    return { mt: 0, h: 14 * 1.45 * lineCount(text, 14, width), mb: 8 }
  }
  if (has('dx-about-note')) {                                  // 11.5px/1.5, margin: 5px 0 0
    return { mt: 5, h: 11.5 * 1.5 * lineCount(text, 11.5, width), mb: 0 }
  }
  if (has('dx-about-row')) {                                   // padding: 2px 0, 8.5rem label
    const control = el.children[1]
    const avail = width - 136 - 10
    const inner = control.tagName === 'INPUT' || control.tagName === 'SELECT'
      ? 25.6                                                   // 13px + 4+4 padding + 2 borders
      : Math.max(13 * 1.45, 12 * 1.5 * lineCount(control.textContent, 12, avail))
    return { mt: 0, h: inner + 4, mb: 0 }
  }
  if (has('dx-about-actions') || has('dx-about-foot')) {
    let row = 0, rows = 1
    for (const b of el.children) {
      const w = BTN_W(b.textContent)
      if (row && row + 8 + w > width) { rows++; row = w } else row += (row ? 8 : 0) + w
    }
    const h = rows * BTN_H + (rows - 1) * 8
    // the footer carries both classes; its own margin-top and rule win
    if (has('dx-about-foot')) return { mt: 14, h: h + 10 + 1, mb: 0 }
    return { mt: 6, h, mb: 0 }
  }
  if (has('dx-about-check')) {                                 // margin: 8px 0 0
    return { mt: 8, h: 14 * 1.45 * lineCount(text, 14, width - 21), mb: 0 }
  }
  if (has('dx-about-vers')) {                                  // 1px border + 4px padding
    let inner = 0
    for (const c of el.children) {
      inner += (c.className || '').includes('dx-about-note')
        ? 11.5 * 1.5 * lineCount(c.textContent, 11.5, width - 26)
        : 25.6 + 2                                             // .dx-about-ver + gap
    }
    return { mt: 0, h: Math.min(inner, VERS_CAP) + 8 + 2, mb: 0 }
  }
  if (has('dx-about-paste')) return { mt: 8, h: 144 + 18, mb: 0 }
  throw new Error(`no box for <${el.tagName} class="${cls}"> — teach the model or the surface grew a shape nobody sized`)
}

/** The card's outer height at this card width, margins collapsed. */
function cardHeight(card: El, cardWidth: number): number {
  const width = cardWidth - 40                    // .dx-about padding: 18px 20px 16px
  let total = 0
  let prevMb = 0
  card.children.forEach((child: El, i: number) => {
    const b = boxOf(child, width, i === 0)
    total += Math.max(prevMb, b.mt) + b.h
    prevMb = b.mb
  })
  return total + prevMb + 34
}

/**
 * The shortest viewport this surface fits in WITHOUT the backdrop scrolling.
 * `.dx-about-back` pads 4vh top and bottom and the card keeps a 12px tail.
 */
const needsViewport = (cardH: number): number => Math.ceil((cardH + 12) / 0.92)

// ------------------------------------------------------------------- fixtures

const wb = parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1',
  docId: '3f9a1c2e-7b40-4d51-9a2f-8c6b0d15e4aa', title: 'Quarterly plan',
  sheets: [{
    id: 'sh1', name: 'Sales', kind: 'table', rids: [[1, 3]],
    columns: [{ id: 'r', name: 'Region', type: 'text' }, { id: 'a', name: 'Amount', type: 'number' }],
    data: { r: { enc: 'dict', dict: ['N', 'S'], idx: [0, 1, 0] }, a: { enc: 'raw', v: [1, 2, 3] } },
    steps: [],
  }],
  theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'sans-serif' },
}))
if (!wb.ok) throw new Error('fixture does not parse')
const store = {
  doc: wb.doc, readOnly: false, touch() {}, replaceDoc() {},
} as unknown as import('../dash/src/store.ts').Store
const hooks = {
  store, showingSheet: () => 'sh1', showSheet() {}, onDirty() {},
} as unknown as import('../dash/src/about.ts').AboutHooks

/** Open a surface and hand back its card, with the version list settled. */
async function open(fn: () => void): Promise<El> {
  fn()
  await new Promise((r) => setTimeout(r, 20))   // listVersions resolves empty here
  return doc.body.querySelector('.dx-about')!
}
const closeAll = () => doc.body.querySelector('.dx-about-back')?.remove()

// ============================================================ the seam
//
// Each surface holds its own half and none of the other's. Stated as what is
// PRESENT and what is ABSENT, because the original's problem was entirely the
// second kind: nothing was missing, everything was in one place.

const aboutCard = await open(() => about.openAbout(hooks))
const aboutText = aboutCard.textContent
const aboutHeads = aboutCard.querySelectorAll('h2').map((n) => n.textContent)
closeAll()

const setCard = await open(() => settings.openSettings(hooks))
const setText = setCard.textContent
const setHeads = setCard.querySelectorAll('h2').map((n) => n.textContent)
closeAll()

{
  ok(aboutHeads.join('|') === 'This file|Document properties|Version history|Take it elsewhere',
    `About holds the file's own four sections and no others (got: ${aboutHeads.join(' · ')})`)
  ok(setHeads.join('|') === 'Settings|Language|Appearance|Updates',
    `Settings holds the reader's own preferences and no others (got: ${setHeads.join(' · ')})`)
  ok(!aboutHeads.some((h) => setHeads.includes(h)),
    'no section is on both surfaces — a heading in two places is how they start being kept in step by hand')
}
{
  // The seam, stated as the thing a control DOES rather than as a list of
  // headings: a preference is a <select> or a checkbox this browser remembers,
  // and About must not have grown one.
  ok(aboutCard.querySelectorAll('select').length === 0,
    'About has no preference picker — language and theme belong to the reader, not to the file')
  ok(aboutCard.querySelectorAll('.dx-about-check').length === 0,
    'and no per-browser switch either (the launch check and Offline mode are Settings)')
  ok(setCard.querySelectorAll('.dx-about-in').length === 0,
    'Settings writes nothing into the document — no author, company, subject or keywords field')
  ok(!setText.includes('Document id') && !setText.includes('JSON'),
    'and says nothing about the identity or the bytes of this particular workbook')
  ok(aboutText.includes('Document id') && aboutCard.querySelectorAll('.dx-about-in').length === 4,
    'About still carries the docId and the four document properties')
  ok(setCard.querySelectorAll('select').length === 2 && setText.includes('Offline mode'),
    'Settings still carries both pickers and the network switch')
}
{
  // PASSWORD. Neither a fact about the file nor a preference of the reader's:
  // a standing instruction about how every save from here on is written, which
  // is what the Save menu is a list of. It must be in exactly one place.
  const menu = src('saveui.ts')
  ok(/item\(t\('Set a password…'\)/.test(menu) && /item\(t\('Remove password…'\)/.test(menu),
    'the password is an item in the Save menu, beside the other decisions about how this file gets written')
  ok(!aboutText.includes('password') && !setText.includes('password'),
    'and it is not in either dialog as well — one door, or they drift')
  // Turning encryption ON has to remove the plaintext snapshots already
  // written: a version timeline in IndexedDB is exactly what the password
  // exists to keep off the disk. The dash rule, moved with the button.
  const item = menu.slice(menu.indexOf("t('Set a password…')"))
  ok(/setEncryptionPassword\(pw\)[\s\S]{0,400}?clearRecovery\([\s\S]{0,200}?clearVersions\(/.test(item),
    'and setting one still clears BOTH the recovery snapshot and the version timeline')
}
{
  // THE SAVE MENU AND "TAKE IT ELSEWHERE" OVERLAPPED. About used to offer "Save
  // a copy…" under the menu's own label, and "Duplicate as new workbook…" which
  // is the menu's "Save as new workbook…". Two doors to one action is how the
  // two spellings drift, and these had: the menu's fork kept `template: true`.
  ok(!aboutText.includes('Save a copy'),
    'About no longer offers "Save a copy…" — the Save menu owns saving, under that exact label')
  ok(!aboutText.includes('Duplicate as new workbook'),
    'nor a second spelling of the identity fork')
  ok(aboutText.includes('Copy document JSON') && aboutText.includes('Replace from JSON'),
    'what stayed is the thing that is not a save at all: the document as text, for an AI or another tool')
  ok(/beside Save/.test(aboutText),
    'and the reader who came looking for a copy is told where it went')
  const menu = src('saveui.ts')
  ok(/import \{ duplicateWorkbook \} from '\.\/about\.ts'/.test(menu)
    && /duplicateWorkbook\(store\.doc, newDocId\(\)\)/.test(menu),
    'the fork has ONE implementation — the tested one in about.ts — and the menu calls it')
}

// ============================================================ the ways in
{
  const app = doc.createElement('div')
  app.innerHTML = '<span class="dx-mark">bento/dash</span>'
    + '<button data-act="about">i</button>'
    + '<button data-act="settings">s</button>'
    + '<span class="dx-ver">v0.3.0</span>'
  doc.body.appendChild(app)
  about.mountAbout(app as never, hooks)

  const click = (sel: string) => {
    closeAll()
    app.querySelector(sel)!.dispatchEvent({ type: 'click' })
    return doc.body.querySelector('.dx-about')?.getAttribute('aria-label') ?? '(nothing opened)'
  }
  ok(click('.dx-mark') === 'About this workbook',
    'the wordmark opens About — it says bento/dash, and what it opens is what this file is')
  ok(click('.dx-ver') === 'Settings',
    'the version chip opens SETTINGS: it reads v0.3.0, and the question a version raises — am I running the newest app — is now answered there')
  ok(click('[data-act="settings"]') === 'Settings',
    'a top-bar Settings button is wired if the build has one (main.ts is another module\'s, so this is optional and harmless when absent)')
  ok(aboutText.includes('Settings'),
    'and About carries a way ACROSS in its footer, so a reader who guessed wrong is one click from right')
  closeAll()
  app.remove()

  // The launch check badges every door, not just the one it used to.
  const boot = src('settings.ts')
  ok(/\[data-act="about"\], \[data-act="settings"\], \.dx-ver/.test(boot),
    'an update found at launch badges all three ways in — the chip is hidden under 1040px, so the dot cannot live only there')
  ok(/open Settings to update/.test(boot),
    'and the badge names the surface that actually holds the Update button')
}

// ============================================================ dormancy
//
// Restated here, on the surface rig, because the predicate moved file: a
// workbook nobody has saved is a STARTER — the demo at bento.page/dash, a
// template someone is kicking the tyres on — and opening the app must not be an
// event anybody's server sees (PLATFORM §5). scripts/test-dash-about.ts proves
// the predicate; this proves the predicate is still the one wired to the boot.
{
  ok(/if \(!shouldCheckAtLaunch\(\{[\s\S]{0,160}?\}\)\) return/.test(src('settings.ts')),
    'checkAtLaunch still refuses through shouldCheckAtLaunch before any fetch is scheduled')
  ok(/export \{ shouldCheckAtLaunch, checkAtLaunch/.test(src('about.ts')),
    'and both are still reachable from about.ts, which is where main.ts imports the boot check from')
}

// ============================================================ the offline note
//
// THE SHIPPED BUG: the checkbox was seeded once from offlineEnabled() and
// thereafter showed its own DOM state, so with site data blocked, ticking
// Offline left the box TICKED while the note under it read "Network features
// are available" — the dialog contradicting itself on screen. The fix is to
// take setOffline's BOOLEAN RETURN, which says whether the preference
// persisted, and say so when it did not.
//
// Node has no localStorage here, which is precisely the storage-blocked case.
{
  const card = await open(() => settings.openSettings(hooks))
  const box = card.querySelectorAll('.dx-about-check input')[1]
  ;(box as unknown as { checked: boolean }).checked = true
  box.dispatchEvent({ type: 'change' })
  const note = card.querySelectorAll('.dx-about-note').pop()!
  ok(/Offline mode is on/.test(note.textContent),
    'ticking Offline says the switch is on')
  ok(/could not be saved/.test(note.textContent),
    'and, when the preference could not persist, says THAT too rather than promising a setting that dies on reload')
  closeAll()
}

// ============================================================ the theme is transient
//
// A `data-theme` attribute on <html> would be cloned into every saved file by
// capturePristine() and force one reader's choice on everyone who opens it.
// The override is a <style> carrying `data-bento-transient`, which the kernel
// strips from every serialized shell.
{
  settings.setThemePref('dark')
  const style = doc.getElementById('dx-theme')
  ok(style !== null && style.hasAttribute('data-bento-transient'),
    'the theme override is a transient <style> — an untagged one is saved into the file and changes everybody’s screen')
  ok(doc.documentElement.getAttribute('data-theme') === null,
    'and nothing is written onto <html>, which is the shape that caused that')
  settings.setThemePref('auto')
  ok(doc.getElementById('dx-theme') === null,
    'and "Match my system" REMOVES it — the absence of an override is what following the OS means')
}

// ============================================================ the size
//
// ONE SCREEN, on a laptop. The card is 560px wide there (min(560px, 100%)).
{
  const LAPTOP = 560
  const aboutH = cardHeight(await open(() => about.openAbout(hooks)), LAPTOP)
  closeAll()
  const setH = cardHeight(await open(() => settings.openSettings(hooks)), LAPTOP)
  closeAll()
  // …and with a FULL version timeline, which is the tallest About ever gets:
  // the list is a fixed window (max-height 5.5rem) rather than a growing one,
  // so this is a bound and not a sample.
  const full = aboutH - 33 + VERS_CAP + 10

  console.log(`\n  measured, at a 560px card (laptop):`)
  console.log(`    About     ${Math.round(aboutH)}px  (${Math.round(full)}px with a full version timeline)`)
  console.log(`    Settings  ${Math.round(setH)}px`)
  console.log(`    shortest viewport that needs no scrolling: About ${needsViewport(full)}px, Settings ${needsViewport(setH)}px`)
  console.log(`    for comparison, the eight-section original: 1361px measured at a 429px viewport\n`)

  ok(needsViewport(full) <= 800,
    `About fits a laptop screen without scrolling (needs ${needsViewport(full)}px of viewport at its tallest)`)
  ok(needsViewport(setH) <= 800,
    `Settings fits a laptop screen without scrolling (needs ${needsViewport(setH)}px of viewport)`)
  // The one that matters for the phone case is that neither surface is a
  // SCROLLER by construction — the whole complaint was 3.2 screens.
  const narrowAbout = cardHeight(await open(() => about.openAbout(hooks)), 397)
  closeAll()
  const narrowSet = cardHeight(await open(() => settings.openSettings(hooks)), 397)
  ok(narrowAbout < 1361 * 0.6 && narrowSet < 1361 * 0.6,
    `and at the 429px viewport where the original measured 1361px, neither surface reaches 60% of it (${Math.round(narrowAbout)}px, ${Math.round(narrowSet)}px)`)
  ok(narrowAbout + narrowSet < 1361,
    'the two of them TOGETHER are shorter than the one dialog they replace — the split removed chrome, it did not duplicate it')
  closeAll()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
