// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// App wrappers provide controls. Delay only file transport; exercise the real
// packaged UI, serialization and acknowledgement. Never skip when Chrome is absent.
import assert from 'node:assert/strict'
export async function runSaveQueueBrowser({ app, title, dirty, afterSave }) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, route => route.abort())
    await context.addInitScript(() => {
      window.testWrites = []; window.testActive = 0; window.testMaxActive = 0;
      window.testReleases = []; window.testBlock = true;
      const handle = { name: 'queue-test.bento.html', async createWritable() {
        window.testActive++; window.testMaxActive = Math.max(window.testMaxActive, window.testActive);
        return { async write(blob) {
          const html = await blob.text();
          const match = html.match(/<script\b[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/i);
          window.testWrites.push(JSON.parse(match[1]));
          if (window.testBlock) await new Promise(resolve => window.testReleases.push(resolve));
        }, async close() { window.testActive-- } };
      } };
      window.showSaveFilePicker = async () => handle;
    })
    const page = await context.newPage(), errors = []
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept())
    const name = app[0].toUpperCase() + app.slice(1)
    await page.goto(new URL(`../../${app}/dist-single/Bento_${name}.bento.html`, import.meta.url).href)
    await page.waitForFunction(() => window.bento?.doc)
    await page.locator(title).fill('First saved revision')
    await page.locator(title).press('Tab')
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForFunction(() => window.testWrites.length === 1)
    await page.locator(title).fill('Second saved revision')
    await page.locator(title).press('Tab')
    await page.keyboard.press('ControlOrMeta+s')
    // Allow automatic write-back to queue behind the blocked manual save too.
    await page.waitForTimeout(2800)
    assert.equal(await page.evaluate(() => window.testWrites.length), 1, app + ' writes do not overlap')
    await page.evaluate(() => window.testReleases.shift()())
    await page.waitForFunction(() => window.testWrites.length === 2)
    assert(await page.locator(dirty).count() > 0, app + ' older save leaves new edits dirty')
    assert.deepEqual(await page.evaluate(() => window.testWrites.slice(0,2).map(d => d.title)), ['First saved revision', 'Second saved revision'])
    await page.evaluate(() => { window.testBlock = false; window.testReleases.splice(0).forEach(release => release()) })
    await page.waitForFunction(() => window.testActive === 0)
    await page.waitForFunction(selector => document.querySelector(selector) === null, dirty)
    if (afterSave) await afterSave(page, { title })
    assert.equal(await page.evaluate(() => window.testMaxActive), 1, app + ' serializes manual and automatic writes')
    assert.deepEqual(errors, [], app + ' has no runtime errors')
    console.log(app + ': packaged UI preserves in-flight snapshot, serializes writes and acknowledges only current revision')
    await context.close()
  } finally { await browser.close() }
}
