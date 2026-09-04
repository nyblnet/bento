// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the extension can and cannot do right now, in one place.
//
// Two things have to be true before a document saves in place, and BOTH fail
// silently by nature: a folder grant that Chrome drops on a browser restart,
// and a file-URL permission that no manifest can request. Neither is visible
// until a save is attempted, which is the worst possible moment to discover
// them — so every surface reads this and says so first.

import { GRANT, get, put } from './db.js'
import { t } from './i18n.js'

/**
 * Every granted folder, oldest first.
 *
 * `dirs` is the list; `dir` is the single-grant key this shipped with, still
 * read so an upgrade does not silently drop the folder someone already granted.
 * Both halves of the extension reach the store through db.js, so there is no
 * longer a second copy of these key names to drift from.
 */
export const getGrants = async () => {
  const list = await get(GRANT, 'dirs')
  if (Array.isArray(list) && list.length) return list
  const one = await get(GRANT, 'dir')
  return one ? [one] : []
}

/** Replace the list. `dir` is cleared once a list exists, so the legacy key
 *  cannot resurrect a folder the user has since removed. */
export const putGrants = async (list) => {
  await put(GRANT, 'dirs', list)
  await put(GRANT, 'dir', null)
}

/**
 * Is "Allow access to file URLs" enabled?
 *
 * No manifest permission grants it and nothing can prompt for it — the user
 * must set it by hand, per extension, and it stays off after a store install
 * too. It IS readable, which is the difference between a guided step and a
 * mystery. Returns null where the API is unavailable rather than guessing:
 * claiming it is off when it is on would send people to fix a working setting.
 */
export async function fileAccess() {
  try {
    const api = chrome.extension?.isAllowedFileSchemeAccess
    if (!api) return null
    const r = api.call(chrome.extension)
    if (r && typeof r.then === 'function') return await r
    return await new Promise((res) => chrome.extension.isAllowedFileSchemeAccess(res))
  } catch {
    return null
  }
}

/**
 * Mark the toolbar icon when a folder needs reconnecting.
 *
 * A lapsed grant used to be invisible until a save fell back to a picker, which
 * is the worst moment to learn about it: the interruption has already happened,
 * and nothing on screen connects it to the extension. The badge moves that
 * discovery BEFORE the save, onto the icon the popup hangs off — the same place
 * the fix is.
 *
 * Best effort. `chrome.action` is absent in the test rig and in any page that
 * imports this module for its data only, and a badge that cannot be set is not
 * worth failing a save over.
 */
export async function setLapsedBadge() {
  try {
    if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return false
    const dirs = await getGrants()
    const perms = await Promise.all(
      dirs.map((d) => d.queryPermission({ mode: 'readwrite' }).catch(() => 'unreadable')),
    )
    // Only when something WAS granted and has lapsed. A user who has never
    // picked a folder is not behind on anything, and badging them would be
    // nagging rather than reporting.
    const stale = dirs.length > 0 && perms.some((p) => p !== 'granted')
    await chrome.action.setBadgeText({ text: stale ? '!' : '' })
    if (stale) {
      await chrome.action.setBadgeBackgroundColor?.({ color: '#C2453B' })
      await chrome.action.setTitle?.({ title: t('actionTitleLapsed') })
    } else {
      await chrome.action.setTitle?.({ title: t('actionTitle') })
    }
    return stale
  } catch {
    /* never let the badge break a save */
    return false
  }
}

const NOTIFIED = 'lapsed-notified'

/**
 * Tell the user ONCE per browser session that a folder needs reconnecting.
 *
 * The badge is passive — it reports to anyone who looks at the toolbar, and
 * nobody looks at the toolbar. A lapse is otherwise discovered when a save
 * falls back to a picker, which is both too late and unattributable.
 *
 * ONCE, though. The worker re-runs this after every message, and a save is
 * many messages; a notification per message would be unusable, and one per
 * save not much better. `chrome.storage.session` is exactly the right
 * lifetime — it clears when the browser restarts, which is also when a grant
 * lapses, so the next session gets exactly one fresh telling.
 *
 * Cleared as soon as the grant is healthy again, so a lapse later in the same
 * session is still announced.
 */
export async function notifyIfLapsed(stale) {
  try {
    if (typeof chrome === 'undefined' || !chrome.notifications?.create) return
    const session = chrome.storage?.session
    const seen = session ? (await session.get(NOTIFIED))[NOTIFIED] : false

    if (!stale) {
      if (seen) await session?.remove(NOTIFIED)
      return
    }
    if (seen) return
    await session?.set({ [NOTIFIED]: true })

    await chrome.notifications.create('bento-home-lapsed', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: t('notifyLapsedTitle'),
      message: t('notifyLapsedBody'),
      buttons: [{ title: t('reconnect') }],
      requireInteraction: false,
    })
  } catch {
    /* a notification is never worth failing a save over */
  }
}

/**
 * Put the reconnect button in front of the user.
 *
 * This used to try `chrome.action.openPopup()`. There is no popup any more —
 * the toolbar icon opens the library, and the tray lives in a side panel — so
 * the notification leads to the library, which carries the same reconnect
 * affordance with room to explain it.
 *
 * Deliberately not `sidePanel.open()`: that must be called synchronously inside
 * a user gesture, and this is reached from a notification click handler after
 * an await. It would be refused, silently, which is the worst of both.
 */
export async function openReconnectUi() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/home.html') })
    return 'library'
  } catch {
    return 'none'
  }
}

/**
 * Everything the UI needs: {files, folders, ready}.
 *
 * `folders` is one row per grant — `{name, permission}` — because with more
 * than one folder the interesting state is per-folder: a single lapsed grant
 * must not read as "the extension is broken", and a single healthy one must not
 * read as "everything is fine". `ready` therefore means at least one folder can
 * be written to, which is the honest summary of "will a save land": it depends
 * on which document.
 */
export async function status() {
  const files = await fileAccess()
  let folders = []
  try {
    const dirs = await getGrants()
    folders = await Promise.all(dirs.map(async (dir) => ({
      name: dir.name,
      permission: await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'unreadable'),
    })))
  } catch {
    folders = [{ name: '(unreadable)', permission: 'unreadable' }]
  }
  return {
    files,
    folders,
    ready: files !== false && folders.some((f) => f.permission === 'granted'),
  }
}
