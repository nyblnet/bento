// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the extension can and cannot do right now, in one place.
//
// Two things have to be true before a deck saves in place, and BOTH fail
// silently by nature: a folder grant that lapses whenever the service worker
// restarts, and a file-URL permission that no manifest can request. Neither is
// visible until a save is attempted, which is the worst possible moment to
// discover them — so the popup and the options page read this and say so first.

const DB = 'bento-tray'
const STORE = 'grant'

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})

const get = async (key) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readonly')
    const q = t.objectStore(STORE).get(key)
    q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error)
  })
}

const put = async (key, v) => {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite')
    t.objectStore(STORE).put(v, key)
    t.oncomplete = res; t.onerror = () => rej(t.error)
  })
}

/**
 * Every granted folder, oldest first.
 *
 * `dirs` is the list; `dir` is the single-grant key this shipped with, still
 * read so an upgrade does not silently drop the folder someone already granted.
 * Kept byte-identical in shape to background.js `readGrants` — the two read the
 * same store and must not disagree about what is in it.
 */
export const getGrants = async () => {
  const list = await get('dirs')
  if (Array.isArray(list) && list.length) return list
  const one = await get('dir')
  return one ? [one] : []
}

/** Replace the list. `dir` is cleared once a list exists, so the legacy key
 *  cannot resurrect a folder the user has since removed. */
export const putGrants = async (list) => {
  await put('dirs', list)
  await put('dir', null)
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
      await chrome.action.setTitle?.({ title: 'Bento Tray — a folder needs reconnecting' })
    } else {
      await chrome.action.setTitle?.({ title: 'Bento Tray' })
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

    await chrome.notifications.create('bento-tray-lapsed', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Bento Tray needs reconnecting',
      message: 'Chrome dropped permission for a folder. Until it is restored, saving '
        + 'a document will ask you where to put it.',
      buttons: [{ title: 'Reconnect' }],
      requireInteraction: false,
    })
  } catch {
    /* a notification is never worth failing a save over */
  }
}

/**
 * Put the reconnect button in front of the user.
 *
 * `chrome.action.openPopup()` is the one that would make this a single click
 * from anywhere. UNVERIFIED here: it has moved between "extension-only", "policy
 * installed only" and generally available across Chrome versions, and this
 * extension's floor is 116. So it is TRIED, and the options page is the fallback
 * — which always works and costs a tab.
 *
 * Deliberately not called on its own initiative. Opening a popup at a moment the
 * user did not ask for one is the kind of thing that gets an extension
 * uninstalled; this runs only from a notification the user clicked.
 */
export async function openReconnectUi() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup()
      return 'popup'
    }
  } catch {
    /* not available in this Chrome, or no focused window — fall through */
  }
  try {
    await chrome.runtime.openOptionsPage()
    return 'options'
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
