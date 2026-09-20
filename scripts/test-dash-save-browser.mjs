// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { runSaveQueueBrowser } from './lib/savequeue-browser.mjs'
await runSaveQueueBrowser({ app: 'dash', title: '.dx-title', dirty: '.dx-dirty:not([hidden])', afterSave: async (page, { title }) => {
      const start = await page.evaluate(() => { window.testBlock = true; return window.testWrites.length });
      const oldId = await page.evaluate(() => window.bento.doc.docId);
      await page.locator(title).fill('Before copy and fork');
      await page.locator(title).press('Tab');
      await page.keyboard.press('ControlOrMeta+s');
      await page.waitForFunction(n => window.testWrites.length === n + 1, start);
      await page.locator('.dxs-caret').click();
      await page.locator('.dxs-item').filter({has: page.locator('span', {hasText: /^Save a copy…$/})}).click();
      await page.locator('.dxs-caret').click();
      await page.locator('.dxs-item').filter({has: page.locator('span', {hasText: /^Save as new workbook…$/})}).click();
      assert.equal(await page.evaluate(() => window.bento.doc.docId), oldId, 'fork waits for previous writes');
      await page.evaluate(() => window.testReleases.shift()());
      await page.waitForFunction(n => window.testWrites.length === n + 2, start);
      assert.equal(await page.evaluate(() => window.bento.doc.docId), oldId, 'copy preserves identity');
      await page.evaluate(() => window.testReleases.shift()());
      await page.waitForFunction(n => window.testWrites.length === n + 3, start);
      const ids = await page.evaluate(n => window.testWrites.slice(n).map(d => d.docId), start);
      assert.equal(ids[0], oldId); assert.equal(ids[1], oldId); assert.notEqual(ids[2], oldId);
      assert.equal(await page.evaluate(() => window.bento.doc.docId), ids[2]);
      await page.evaluate(() => { window.testBlock = false; window.testReleases.splice(0).forEach(release => release()) });
      await page.waitForFunction(() => window.testActive === 0);
      console.log('dash: Save, Save a copy and Save as new workbook share write ordering and preserve/fork identity correctly');

} })
