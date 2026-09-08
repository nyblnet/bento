// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The extension side: the only place that holds the folder grant and the only
// place that writes.
//
// MEASURED (docs/DECISIONS.md, 2026-08-02): one `showDirectoryPicker` grant
// survives IndexedDB and a reload — still `granted` with no gesture, and
// re-grantable with one click when it lapses — and covers files INSIDE the
// folder that were never picked. That is what lets a deck opened by
// double-clicking be written without a destination prompt, which no web page
// can do for itself.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. NO STATE BETWEEN MESSAGES. An MV3 service worker is evicted whenever the
//    browser feels like it, and a save serialises the whole deck first —
//    encryption, preview, ~900KB — so an eviction can easily land between
//    "which file is this?" and "write it". Anything held in memory across that
//    gap produces a failed save that looks random and reproduces on nobody's
//    machine. So every message re-resolves from the grant; nothing is cached.
//
// 2. THE PAGE DOES NOT GET TO SAY WHICH FILE IT IS. `sender.url` is set by the
//    browser, not by the content script, so it cannot be forged by the document
//    — whereas anything in the message payload can. A local HTML file is
//    untrusted content; if it could name its own target it could name somebody
//    else's deck in the granted folder and overwrite it. The path comes from
//    the sender, and a payload path is ignored even if present.

// The ONLY import here. status.js owns what the UI is told, and the badge is
// UI — duplicating the "is anything lapsed?" rule would let the icon and the
// popup disagree about the same folders.
import { setLapsedBadge, notifyIfLapsed, openReconnectUi, getGrants } from './status.js'
import { checkForUpdate } from './update.js'
import { learnPrefix } from './db.js'
import { t } from './i18n.js'
import { pathFromSender, locateIn } from './route.js'

// Re-exported: these moved to route.js so the PAGES can place a path too,
// but they are still part of this module's tested surface.
export { pathFromSender, locateIn }

/** Refresh the badge, and tell the user once per session if a grant lapsed. */
const reportLapsed = async () => notifyIfLapsed(await setLapsedBadge())

/** The grants, read through the shared store. */
const readGrants = getGrants

/** Every file of this name in the granted tree. Depth-limited: a Decks folder
 *  is not a filesystem, and an unbounded walk on a mistakenly-granted home
 *  directory would hang the save the user is waiting on.
 *
 *  KEPT AS A FALLBACK ONLY. `locateIn` handles every path whose grant name
 *  appears in it, which is all of them in the ordinary case; this covers what
 *  it cannot place — a symlinked route, say, where the path the browser reports
 *  does not spell the directory the handle actually points at. */
export async function findByName(dir, name, depth = 0, found = []) {
  if (depth > 4 || found.length > 1) return found
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName === name) found.push(handle)
    else if (handle.kind === 'directory' && !entryName.startsWith('.')) {
      await findByName(handle, name, depth + 1, found)
    }
    if (found.length > 1) break // ambiguous is already an answer
  }
  return found
}

/**
 * Resolve the writable handle for a sender's own file, or say why not.
 *
 * ACROSS EVERY GRANT. Each is tried by ROUTE (`locateIn`) rather than by
 * search, so trying several costs a few lookups each and a grant's size stops
 * mattering — granting a whole home directory is as cheap as granting one decks
 * folder, which is what makes "everywhere" a reasonable thing to offer.
 *
 * A file reachable through two grants is normal once folders can nest
 * (~/Documents and ~/Documents/Decks), and it is the SAME file by two routes,
 * not an ambiguity — `isSameEntry` is the thing that can tell those apart, so
 * it decides. Two genuinely different files can only happen if the browser
 * reported a path that leads to both, which it cannot; if it somehow does, that
 * is the case to decline.
 *
 * A LAPSED grant is reported distinctly from an absent one, because they need
 * opposite things from the user: one click to renew, or a folder to pick. Only
 * reported when NO grant could serve the file — with several folders, one
 * lapsing must not mask the others.
 */
export async function resolve(sender, deps = {}) {
  const grants = deps.readGrants ?? readGrants
  const search = deps.findByName ?? findByName
  const locate = deps.locateIn ?? locateIn

  const path = pathFromSender(sender)
  if (!path) return { ok: false, reason: 'not a local file' }

  const all = await grants()
  if (!all.length) return { ok: false, reason: 'no folder granted' }

  const name = path.split('/').pop() || ''
  if (!name) return { ok: false, reason: 'no file name' }

  let lapsed = 0
  const found = []
  for (const dir of all) {
    // queryPermission only — never prompt from here. A service worker has no
    // user gesture, so a request would be refused, and a save is the wrong
    // moment to discover that. The options page is where granting happens.
    if (await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') { lapsed++; continue }
    for (const hit of await locate(dir, path)) found.push({ dir, ...hit })
    // Only fall back to enumerating when the route found nothing in this grant.
    if (!found.length) {
      for (const file of await search(dir, name)) found.push({ dir, file, rel: null })
    }
  }

  if (!found.length) {
    return {
      ok: false,
      reason: lapsed
        ? 'folder grant needs renewing'
        : 'not in the granted folder',
    }
  }
  if (found.length > 1) {
    // The same file reached twice through nested grants is fine; two different
    // files are not, and only isSameEntry can tell them apart.
    const [first, ...rest] = found
    for (const other of rest) {
      if (!(await first.file.isSameEntry(other.file))) {
        return { ok: false, reason: `${name} is ambiguous across the granted folders` }
      }
    }
    found.length = 1
  }

  const { dir, file } = found[0]
  const hits = [file]

  // The candidate shares the sender's FILE NAME. That is not the same as being
  // the sender's file, and treating it as such destroys documents:
  //
  //   grant = ~/Documents, which holds ~/Documents/Clients/Q3.bento.html
  //   the user opens a working copy at ~/Desktop/Q3.bento.html
  //   -> exactly one hit, so a save wrote the Desktop deck over the Clients one
  //      and never wrote the file being edited.
  //
  // The ambiguity guard above cannot catch that: the sender's own copy is
  // OUTSIDE the grant, so it is not a second hit. No attacker is required.
  //
  // `resolve()` on the directory gives the candidate's path segments relative to
  // the grant, so the sender's absolute path must end with them. An earlier
  // comment here claimed the two "cannot be compared directly" — that is true of
  // the directory handle, which knows no path, but not of a resolved child.
  const rel = await dir.resolve(hits[0])
  if (!rel || !rel.length) return { ok: false, reason: 'not inside the granted folder' }
  const suffix = `/${rel.join('/')}`
  // The subtraction that makes a document list clickable. Both halves exist
  // only here: `path` is absolute and browser-stamped, `suffix` is the same
  // file's route from the grant root, so what remains is where the granted
  // folder actually lives. Nothing else in the extension can learn this — a
  // directory handle has no path — and without it the popup can list documents
  // but not open them.
  //
  // Deliberately AFTER the identity check below is set up but before it
  // returns: only recorded on the success path, so a mismatched candidate never
  // teaches us a wrong prefix. Failures are swallowed; a save must not break
  // because a convenience could not be cached.
  if (path.endsWith(suffix)) {
    try { await learnPrefix(dir.name, path.slice(0, -suffix.length)) } catch { /* nice-to-have */ }
  }
  if (!path.endsWith(suffix)) {
    return { ok: false, reason: `${name} in the granted folder is a different file` }
  }

  return { ok: true, name, handle: hits[0], within: suffix, dir, rel }
}

/**
 * The directory a resolved file actually sits in.
 *
 * `rel` is the file's path segments relative to the grant root, so its parent is
 * the grant walked down every segment but the last. Re-walked from the grant
 * rather than remembered, for the same reason as everything else here: a service
 * worker can be evicted between two messages.
 */
async function parentOf(dir, rel) {
  let cur = dir
  for (const seg of rel.slice(0, -1)) cur = await cur.getDirectoryHandle(seg)
  return cur
}

/**
 * Is `proposed` a name this sender is allowed to create beside itself?
 *
 * The page supplies it, so it is untrusted, and it is about to become a
 * filename in somebody's folder. Rather than sanitising toward safety — which
 * invites arguments about what was missed — this only accepts names that are
 * transparently derived from the sender's OWN file: same base, our extension,
 * and nothing in between but the characters a version string is made of.
 *
 * A separator therefore cannot survive, so no name can escape the directory,
 * and the sender can only ever write near itself. `!== own` is the one that
 * matters most: without it the "backup" is the original.
 */
export function backupNameFor(own, proposed) {
  if (typeof proposed !== 'string' || proposed.length > 128) return null
  if (!/^[A-Za-z0-9._-]+$/.test(proposed)) return null // no / \ .. NUL, no spaces
  if (!/\.bento\.html$/i.test(proposed)) return null
  if (proposed === own) return null
  const base = own.replace(/\.bento\.html$/i, '')
  return proposed.startsWith(`${base}.`) ? proposed : null
}

/**
 * Write a rollback copy beside the sender's own file.
 *
 * NEW AUTHORITY, deliberately narrow. Every other op writes a file that already
 * exists and that the sender IS; this one creates a file. The blast radius is
 * held down from both ends: the name must be derived from the sender's own
 * (`backupNameFor`), and an existing file is never overwritten. So the worst a
 * hostile document can do is leave one predictably-named copy of ITSELF in a
 * folder the author granted — which is what the feature does when it works.
 */
export async function backup(sender, text, name, deps) {
  const r = await resolve(sender, deps)
  if (!r.ok) return { ok: false, reason: r.reason }

  const safe = backupNameFor(r.name, name)
  if (!safe) return { ok: false, reason: 'not a backup name for this file' }

  try {
    const parent = await parentOf(r.dir, r.rel)
    // Create-only. `getFileHandle` without `create` throws NotFoundError when
    // the name is free — that throw is the success case, and anything else
    // means something is already there and is not ours to replace.
    let taken = true
    try { await parent.getFileHandle(safe) } catch (e) { taken = e?.name !== 'NotFoundError' }
    if (taken) return { ok: false, reason: `${safe} already exists` }

    const h = await parent.getFileHandle(safe, { create: true })
    const w = await h.createWritable()
    await w.write(text)
    await w.close()
    return { ok: true, name: safe, bytes: text.length }
  } catch (e) {
    return { ok: false, reason: `${e.name}: ${e.message}` }
  }
}

/** Can this sender's file be written in place? Resolves; writes nothing. */
export async function claim(sender, deps) {
  const r = await resolve(sender, deps)
  return r.ok ? { ok: true, name: r.name } : { ok: false, reason: r.reason }
}

/** Write the sender's own file. Re-resolves, so no state is carried. */
export async function write(sender, text, deps) {
  const r = await resolve(sender, deps)
  if (!r.ok) return { ok: false, reason: r.reason }
  try {
    const w = await r.handle.createWritable()
    await w.write(text)
    await w.close()
    return { ok: true, bytes: text.length }
  } catch (e) {
    return { ok: false, reason: `${e.name}: ${e.message}` }
  }
}

// `chrome` is absent when this module is loaded by the test rig, which imports
// the logic above and never needs the listener.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // `hello` is a claim by another name: it resolves the sender against the
    // grants, which is what teaches `db.learnPrefix` where that folder lives,
    // and writes nothing. Opening a document is the moment to learn its folder
    // — waiting for a save meant a fresh install listed documents it could not
    // open.
    const run = msg?.op === 'hello' ? claim(sender)
      : msg?.op === 'claim' ? claim(sender)
      : msg?.op === 'write' ? write(sender, msg.payload?.text ?? '')
      : msg?.op === 'backup' ? backup(sender, msg.payload?.text ?? '', msg.payload?.name)
      : Promise.resolve({ ok: false, reason: 'unknown op' })
    run.then((r) => {
      sendResponse(r)
      // A lapsed grant is otherwise invisible until a save has ALREADY fallen
      // back to a picker. Badging the toolbar icon moves that discovery onto
      // the thing the fix hangs off, and does it whether the save succeeded or
      // not — one folder can lapse while another still works.
      void reportLapsed()
    }, (e) => sendResponse({ ok: false, reason: String(e?.message || e) }))
    return true // async response
  })

  // The worker restarts constantly; the badge has to survive that, and startup
  // is also when a browser restart would have dropped a grant — so it is the
  // one moment where telling the user is worth an interruption, since it is
  // before they have tried to save anything.
  chrome.runtime.onStartup?.addListener(() => void reportLapsed())
  chrome.runtime.onInstalled?.addListener(() => void reportLapsed())

  // Whether an unpacked install is behind. Startup only, plus a manual check in
  // Settings: a browser session is the natural granularity, and a daily alarm
  // would cost the `alarms` permission for a courtesy. Store installs are never
  // asked — `checkForUpdate` returns immediately for them.
  chrome.runtime.onStartup?.addListener(() => void checkForUpdate())
  chrome.runtime.onInstalled?.addListener(() => void checkForUpdate())
  void reportLapsed()

  /**
   * The toolbar icon opens the LIBRARY, not a popup.
   *
   * Two surfaces, two jobs. The page is for browsing and managing — folders,
   * search, rename, settings — and wants room and a tab that stays. The panel
   * is for switching documents while you are working in one, and wants to sit
   * beside that document rather than vanish when you click into it.
   *
   * `onClicked` only fires when no `default_popup` is declared: setting one
   * makes the click open the popup and this listener never run. So the manifest
   * has no popup, and the panel is reached by its own gestures below.
   *
   * An existing tab is FOCUSED rather than duplicated. Opening the library four
   * times should not leave four copies of it.
   */
  chrome.action.onClicked.addListener(async () => {
    const url = chrome.runtime.getURL('src/home.html')
    const [open] = await chrome.tabs.query({ url })
    if (open) {
      await chrome.tabs.update(open.id, { active: true })
      await chrome.windows.update(open.windowId, { focused: true })
    } else {
      await chrome.tabs.create({ url })
    }
  })

  /**
   * The panel, from a keyboard shortcut.
   *
   * `sidePanel.open()` must be called SYNCHRONOUSLY inside the gesture that
   * triggered it — Chrome 116+, which is this extension's floor exactly. An
   * `await` before it, even a trivial one, loses the gesture and the call is
   * refused. So nothing is read first; the panel decides what to show once it
   * is up.
   */
  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== 'open-panel') return
    chrome.sidePanel.open(tab?.windowId != null
      ? { windowId: tab.windowId }
      : { windowId: chrome.windows.WINDOW_ID_CURRENT })
  })

  // And from a right-click inside a document, which is where wanting it
  // actually happens. Same synchronous rule.
  /**
   * A fresh install opens the welcome view once.
   *
   * `reason === 'install'` only — an UPDATE must not steal a tab, and a browser
   * that reloads an unpacked extension fires this every time. The first
   * question after installing is "what did I just install and what does it need
   * from me", and the toolbar icon answers none of that until someone clicks it.
   */
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return
    void chrome.tabs.create({ url: `${chrome.runtime.getURL('src/home.html')}#welcome` })
  })

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus.create({
        id: 'bento-home-panel',
        title: t('ctxOpenPanel'),
        contexts: ['page'],
        documentUrlPatterns: ['file:///*'],
      })
    })
  })
  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'bento-home-panel' && tab?.windowId != null) {
      chrome.sidePanel.open({ windowId: tab.windowId })
    }
  })

  // The notification's only button, and clicking the notification body itself —
  // both mean "fix it", so both lead to the same place.
  chrome.notifications?.onButtonClicked?.addListener((id) => {
    if (id === 'bento-home-lapsed') void openReconnectUi()
  })
  chrome.notifications?.onClicked?.addListener((id) => {
    if (id === 'bento-home-lapsed') void openReconnectUi()
  })
}
