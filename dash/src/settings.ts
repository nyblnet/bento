// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Settings: the choices that belong to WHOEVER IS READING, not to the file.
//
// THE SEAM. Everything in here is a preference held in this browser, about this
// screen, for this person — the interface language, the theme, whether the file
// asks the release channel for a newer app, and the hard no-network switch. Not
// one of them is written into the workbook, and that is not an implementation
// detail: PLATFORM §8 makes it a rule. Two people opening the same file may
// read it in different languages and different themes exactly as they may read
// a book under different lamps, and a document that carried either would change
// one reader's screen because of what another reader preferred.
//
// About (about.ts) is the other side of the same line: everything THERE travels
// in the file. If a new control is a thing the file remembers, it goes there;
// if it is a thing this browser remembers, it goes here. There is no third
// category, which is what makes the split predictable from the two names.
//
// The update check lives here rather than in About for the same reason: the
// version of the APP is not a property of the document. A workbook written in
// 2026 opens in every later build, so "am I running the newest app" is a
// question about this copy of the reader's software.

import {
  APP_VERSION, applyUpdate, applyUpdateInPlace, autoCheckEnabled, canUpdateInPlace,
  checkForUpdates, offlineEnabled, setAutoCheck, setOffline,
  type ReleaseInfo, type UpdateCheck,
} from '../../kernel/src/update.ts'
import { disconnectOnline, joinFromDoc } from './sync/online.ts'
import type { SyncSession } from './sync/session.ts'
import { openDialog } from './dialog.ts'
import { themeChoice, setTheme, type ThemeChoice } from '../../kernel/src/theme.ts'
import { t, locale, localeChoices, setLocale } from './i18n.ts'
import type { Store } from './store.ts'

export interface SettingsHooks {
  store: Store
  /**
   * The live session, when the app has one.
   *
   * Offline mode is a HARD switch — "nothing about you or this document leaves
   * this computer" — and a switch that only stops the NEXT connection while an
   * open socket keeps streaming edits does not mean that. `online.ts` guards
   * every join with `offlineEnabled()`, so the missing half is hanging up the
   * one that is already open. Optional: an app with no session still gets the
   * update half of the switch.
   */
  sync?: SyncSession
}

// --- the launch-time update check (PLATFORM §6) -------------------------------

/**
 * Should this file ask the release channel for a newer app, unprompted?
 *
 * THREE CONDITIONS, and the first is the one that is easy to miss. A workbook
 * that has never been saved is the STARTER this build just made — the demo at
 * bento.page/dash, a template someone is kicking the tyres on — and it has no
 * user, no history and nothing to update. PLATFORM §5 makes dormancy the rule
 * for collaboration in as many words ("a fresh template or demo must never
 * phone home"), and an update check is the same promise: opening the app must
 * not be an event anybody's server sees. Once the file exists on disk it is
 * somebody's document, and telling its owner that a newer app exists is the
 * whole point of the signed channel.
 *
 * The other two are the viewer's own settings — the launch check is opt-OUT
 * (`bento-auto-check`), Offline mode is an absolute no.
 *
 * Pure, and exported, because every one of these failures is silent: a check
 * that never fires looks exactly like a channel with nothing new on it.
 */
export function shouldCheckAtLaunch(i: {
  /** did this workbook arrive in the file, or did this build just mint it? */
  saved: boolean
  autoCheck: boolean
  offline: boolean
}): boolean {
  return i.saved && i.autoCheck && !i.offline
}

/** The launch check's result, for the status line in Settings. */
let launchCheck: UpdateCheck | null = null

/**
 * Run the launch check and badge the ways in.
 *
 * WHY A BADGE AND NOT A DIALOG: an update is not urgent and the file works
 * forever as it is, so it waits behind a door the reader already has. THREE
 * doors are badged, because the update now lives in Settings and the reader may
 * arrive from any of them: the version chip (which is the natural one — it is
 * the version), the ⓘ button (About carries a badged way through to Settings),
 * and a Settings button in the top bar if this build has one. The chip is
 * `display: none` under 1040px (styles.css), which is why the others carry the
 * dot too.
 *
 * Deferred a beat so the first paint, the grid and the recovery banner are not
 * competing with a fetch, and so a workbook opened and closed in a second never
 * makes the request at all.
 */
export function checkAtLaunch(opts: { saved: boolean; delayMs?: number }): void {
  if (!shouldCheckAtLaunch({
    saved: opts.saved, autoCheck: autoCheckEnabled(), offline: offlineEnabled(),
  })) return
  setTimeout(() => {
    void checkForUpdates().then((res) => {
      launchCheck = res
      if (res.status !== 'update') return
      const v = res.release.version
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-act="about"], [data-act="settings"], .dx-ver')) {
        el.classList.add('dx-update-badge')
        el.title = t('Version {v} is available — open Settings to update.', { v })
      }
      const chip = document.querySelector<HTMLElement>('.dx-ver')
      if (chip) chip.textContent = `v${APP_VERSION} → v${v}`
    })
  }, opts.delayMs ?? 1500)
}

/** Is there a release waiting? About badges its way through to here. */
export const updateWaiting = (): boolean => launchCheck?.status === 'update'

// --- theme: a VIEWER preference, never the document's --------------------------
//
// The same shape as story.ts's reduced-motion switch and the interface
// language: ONE PERSON's preference about their own screen, in localStorage,
// never in the format (PLATFORM §8). `doc.theme` in model.ts is a DIFFERENT
// thing — the document's own palette, which travels in the file and colours
// the charts and the static preview. Nothing here touches it.
//
// THE MECHANISM IS kernel/src/theme.ts, shared with slides, spaces and type:
// `data-theme` on <html>, which styles.css keys off, plus `color-scheme` for
// the browser's own furniture. Dash had its own store here until 2026-09-12 —
// a transient <style> pinning `color-scheme`, with the palette written as
// light-dark() pairs — and the reason it gave was a real, measured bug: with
// the attribute set at module load, `bento.serialize()` came back with
// `<html data-theme="light">`, because capturePristine() clones the live
// document and every save re-serializes that clone.
//
// THE ANSWER TO THAT IS ORDER, NOT A DIFFERENT MECHANISM. startTheme() is
// called from main.ts AFTER capturePristine() and before the first paint, so
// the pristine copy never carries the attribute and nothing is painted in the
// wrong theme first. slides documents the same two constraints at its own call
// site. The rig proves the saved-file half by serializing under a dark theme
// and grepping the result.
//
// What decided the switch: measured in a browser, `data-theme="dark"` on dash
// did nothing, so a shared kernel stylesheet keyed off the attribute — the only
// key slides can use, since it pins `color-scheme: only light` — could not have
// themed dash at all. The same localStorage key ('bento-theme') was already in
// use here, so an existing preference carries over untouched.


// --- the dialog ---------------------------------------------------------------

/**
 * Language, appearance, updates and the network switch.
 *
 * Reached from the version chip (the version IS the update question), from
 * About's footer, and from a top-bar Settings button where the build has one.
 */
export function openSettings(hooks: SettingsHooks): void {
  const { store } = hooks
  const d = openDialog(t('Settings'))
  const { card, note, close } = d

  const lede = document.createElement('p')
  lede.className = 'dx-about-lede'
  lede.textContent = t('These are yours, not the workbook’s: they are kept in this browser and never written into the file, so the same workbook can be English and light on your screen and Japanese and dark on someone else’s.')
  card.append(d.h(t('Settings')), lede)

  // --- language -------------------------------------------------------------
  card.append(d.h(t('Language')))
  const choices = localeChoices()
  const sel = document.createElement('select')
  for (const c of choices) {
    const o = document.createElement('option')
    o.value = c.code
    o.textContent = c.label
    if (c.code === locale()) o.selected = true
    sel.append(o)
  }
  sel.addEventListener('change', () => {
    setLocale(sel.value)
    close()
    // NOT a repaint: main.ts builds the top bar, the grid chrome and the status
    // bar from one template string with no way back in, so there is nothing to
    // call. Menus, dialogs and findings built after this point are localized;
    // the chrome catches up on the next open.
    openSettings(hooks)
  })
  card.append(d.row(t('Interface language'), sel))
  card.append(note(choices.length > 1
    ? t('The rest of the interface catches up the next time this file is opened.')
    : t('Only English so far.')))

  // --- appearance -----------------------------------------------------------
  // Beside Language, because it is the same KIND of setting, and with no note
  // of its own: the lede above already says where these live, and repeating it
  // three times is how a dialog gets to be three screens tall. Applied live —
  // the palette is custom properties, so the running app re-resolves without a
  // rebuild, and unlike the language picker this one does not have to close and
  // reopen the dialog.
  card.append(d.h(t('Appearance')))
  const themes: Array<[ThemeChoice, string]> = [
    ['auto', t('Match my system')],
    ['light', t('Light')],
    ['dark', t('Dark')],
  ]
  const themeSel = document.createElement('select')
  const current = themeChoice()
  for (const [v, label] of themes) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (v === current) o.selected = true
    themeSel.append(o)
  }
  themeSel.addEventListener('change', () => setTheme(themeSel.value as ThemeChoice))
  card.append(d.row(t('Theme'), themeSel))

  // --- updates --------------------------------------------------------------
  card.append(d.h(t('Updates')))
  const upStatus = note(t('An update is verified before anything is rewritten: the release manifest is signed, and its signature is checked against a key inside this file.'))
  card.append(upStatus)
  const upActions = d.actions()
  card.append(upActions)

  /** Offer a release: one button, and the two shapes taking it can have. */
  const offer = (rel: ReleaseInfo) => {
    upStatus.textContent = t('Version {v} is available.', { v: rel.version })
    // Once. `offer` can be reached twice — the launch check found one, then the
    // reader pressed Check anyway — and a second notes paragraph plus a second
    // Update button is what that looked like.
    if (upActions.querySelector('.dx-about-take')) return
    // The release notes ride INSIDE the signed manifest, so they are as
    // tamper-proof as the shell — worth showing while someone decides.
    if (rel.notes) card.insertBefore(note(rel.notes), upActions)
    const take = d.button(t('Update this file'), () => {
      upStatus.textContent = t('Downloading and verifying…')
      // Two shapes, and the difference is worth stating because one of them
      // leaves the file on disk untouched and the other does not.
      const run = canUpdateInPlace()
        ? applyUpdateInPlace(rel, store.doc).then((ok) => ok
          ? t('Updated. A backup of the old version was downloaded beside it — reload to run {v}.', { v: rel.version })
          : t('Cancelled — nothing was changed.'))
        : applyUpdate(rel, store.doc).then(() =>
          t('Downloaded. Open the new file — this one is unchanged.'))
      void run
        .then((msg) => { upStatus.textContent = msg })
        .catch((err: unknown) => {
          upStatus.textContent = t('The update was refused: {why}', {
            why: err instanceof Error ? err.message : String(err),
          })
        })
    })
    take.classList.add('dx-about-take')
    upActions.append(take)
  }

  // What the LAUNCH check found, if it ran. Without this the dialog is silent
  // about a check the file already made on the reader's behalf — and the badge
  // that brought them here would have nothing to explain itself with.
  if (launchCheck?.status === 'update') offer(launchCheck.release)
  else if (launchCheck?.status === 'current') {
    upStatus.textContent = t('Checked at launch — you have the newest version ({v}).', { v: APP_VERSION })
  } else if (launchCheck?.status === 'error') {
    upStatus.textContent = t('The launch check could not reach the release channel ({why}). Try again below.', { why: launchCheck.message })
  }

  upActions.append(d.button(t('Check for updates'), () => {
    if (offlineEnabled()) {
      upStatus.textContent = t('Offline mode is on, so nothing was contacted.')
      return
    }
    upStatus.textContent = t('Checking…')
    void checkForUpdates().then((res) => {
      launchCheck = res
      if (res.status === 'current') {
        upStatus.textContent = t('You have the newest version ({v}).', { v: APP_VERSION })
        return
      }
      if (res.status !== 'update') {
        upStatus.textContent = t('Could not check for updates: {why}', { why: res.message })
        return
      }
      offer(res.release)
    })
  }))

  card.append(d.check(
    t('Check for updates automatically when this file is opened'),
    autoCheckEnabled(),
    (on) => setAutoCheck(on),
  ))

  // THE HARD NO-NETWORK SWITCH, and until it was built dash could only READ it:
  // the dialog printed "Offline mode is on, so nothing was contacted" for a
  // setting no part of the app could set. For an app with live collaboration in
  // it, the privacy switch has to be reachable without a console.
  const offNote = note('')
  // `stuck` is setOffline's return: whether the preference PERSISTED. It is
  // session state, not a setting, so it resets with the dialog rather than
  // being remembered.
  let stuck = true
  const sayOffline = () => {
    offNote.textContent = offlineEnabled()
      ? t('Offline mode is on: no update checks, no relay. Nothing leaves this computer. Sheets sync between tabs on this machine as before — that is not networking.')
      : t('Network features are available: the signed update check, and live collaboration when you start it.')
    // A switch that will not survive a reload still has to say so. This is the
    // half the gate cannot tell you: `offlineEnabled()` now answers from the
    // session flag, so the note above is TRUE for this tab either way, and the
    // only thing left to be wrong about is how long it lasts.
    if (!stuck) {
      offNote.textContent += ' ' + t('This choice could not be saved — site data is blocked or full — so it holds for this tab and will be forgotten when you reload.')
    }
  }
  sayOffline()
  card.append(d.check(
    t('Offline mode — block every network feature (updates, live collaboration)'),
    offlineEnabled(),
    (on) => {
      // Take the RETURN. Swallowing it is the shipped bug this replaces:
      // the checkbox was seeded once from offlineEnabled() and thereafter
      // showed its own DOM state, so with storage blocked, ticking Offline
      // left the box TICKED while the note under it read "Network features
      // are available" — measured, the dialog contradicting itself on screen.
      stuck = setOffline(on)
      // HANG UP, do not merely refuse the next call. Every join path in
      // online.ts already checks offlineEnabled(); an open socket does not.
      if (hooks.sync) {
        if (on) disconnectOnline(hooks.sync)
        else joinFromDoc(hooks.sync, store) // re-joins only if this doc is shared
      }
      sayOffline()
    },
  ))
  card.append(offNote)

  const foot = d.actions(d.button(t('Close'), close))
  foot.classList.add('dx-about-foot')
  card.append(foot)
  d.mount()
}
