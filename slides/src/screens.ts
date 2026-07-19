// Shared Window Management state.
//
// Granting the browser's "window management" permission needs a DEDICATED user
// gesture — it can't ride the S keypress during present (that activation is
// already spent on window.open / requestFullscreen). So the editor grants it
// from the properties panel BEFORE presenting, we cache the LIVE ScreenDetails
// object here, and present mode reads the second-screen coordinates
// synchronously when the speaker view opens.

let cached: { screens: any[]; currentScreen: any } | null = null

export function windowManagementSupported(): boolean {
  return typeof (window as unknown as { getScreenDetails?: unknown }).getScreenDetails === 'function'
}

export function screensCached(): boolean {
  return !!cached
}

/** Call INSIDE a user gesture. Prompts once if needed, then caches the live
 *  details object (it auto-updates as displays change). */
export async function grantScreens(): Promise<{ ok: boolean; screens: number }> {
  const gsd = (window as unknown as { getScreenDetails?: () => Promise<any> }).getScreenDetails
  if (!gsd) return { ok: false, screens: 0 }
  try {
    cached = await gsd.call(window)
    return { ok: true, screens: cached?.screens?.length ?? 1 }
  } catch {
    return { ok: false, screens: 0 }
  }
}

/** At load: if the permission is already granted from a prior session, cache
 *  the layout without a prompt so present mode Just Works. */
export async function refreshScreensIfGranted(): Promise<void> {
  if (cached || !windowManagementSupported()) return
  try {
    const state = (await (navigator as unknown as { permissions?: { query?: (o: unknown) => Promise<{ state: string }> } })
      .permissions?.query?.({ name: 'window-management' as PermissionName }))?.state
    if (state === 'granted') await grantScreens()
  } catch { /* query unsupported — the panel button remains the path */ }
}

/** The display to put speaker notes on, or null if there isn't a usable second one. */
export function secondScreen(): any | null {
  const s = cached
  if (!s || !Array.isArray(s.screens) || s.screens.length < 2) return null
  return s.screens.find((x) => x !== s.currentScreen) ?? s.screens.find((x) => !x.isPrimary) ?? s.screens[1]
}
