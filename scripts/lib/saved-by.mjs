// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A file an app's OWN save wrote: boot the shell in Chromium, press ⌘S with the
// File System Access picker removed, and take the download fallback. The only
// honest source for the bytes a release writes (the preview remover exists
// only in saved files), and it doesn't depend on any app's scripting API: type's
// window.bento.serialize returns JSON, not a file. Works on every slides
// release from 0.7.0 on (measured).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function savedBy(browser, shellPath) {
  const context = await browser.newContext({ acceptDownloads: true })
  await context.route(/^https?:/, (r) => r.abort())
  await context.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker })
  const page = await context.newPage()
  try {
    await page.goto(pathToFileURL(resolve(shellPath)).href)
    await page.waitForFunction(() => window.bento?.doc, null, { timeout: 30000 })
    await page.waitForTimeout(1500)
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    const download = page.waitForEvent('download', { timeout: 15000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    return readFileSync(await (await download).path(), 'utf8')
  } finally {
    await context.close()
  }
}
