// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage(); const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.route(/^https?:/, r => r.abort());
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href);
  await p.waitForFunction(() => window.bento?.doc);
  // #516: JSON replacement must refresh fonts, including removals and undo.
  const original = await p.evaluate(() => structuredClone(window.bento.doc));
  const custom = structuredClone(original);
  const fontBytes = fs.readFileSync(new URL('./gallery-fonts/SpaceMono-400-latin.woff2', import.meta.url)).toString('base64');
  custom.fonts = [{ family: 'Review516', asset: 'review-font' }];
  custom.assets = { ...custom.assets, 'review-font': 'data:font/woff2;base64,' + fontBytes };
  async function replace(doc) {
    await p.getByRole('button',{name:'Save as… — copy, new deck, password',exact:true}).click();
    await p.getByText('Replace from JSON…',{exact:true}).click();
    await p.locator('.ed-about-json').fill(JSON.stringify(doc));
    await p.locator('.ed-about-overlay').getByRole('button',{name:'Apply',exact:true}).click();
  }
  await replace(custom);
  assert(await p.evaluate(async () => {
    await document.fonts.load('32px Review516');
    return [...document.fonts].some(f => f.family.includes('Review516') && f.status === 'loaded');
  }));
  await p.evaluate(() => {
    window.fontChanges = 0;
    window.fontObserver = new MutationObserver(r => window.fontChanges += r.length);
    window.fontObserver.observe(document.getElementById('bento-fonts'), { childList: true, characterData: true, subtree: true });
  });
  for (let i=0;i<3;i++) {
    await p.locator('.ed-title').fill('Unrelated edit ' + i);
    await p.locator('.ed-title').press('Tab');
  }
  assert.equal(await p.evaluate(() => window.fontChanges), 0);
  const removed = structuredClone(custom); removed.fonts = []; delete removed.assets['review-font'];
  await replace(removed);
  const absent = () => p.evaluate(() => !document.getElementById('bento-fonts').textContent.includes('Review516') &&
    ![...document.fonts].some(f => f.family.includes('Review516')));
  assert(await absent());
  await replace(custom);
  await p.evaluate(() => window.bento.undo());
  assert(await absent());
  await p.evaluate(() => window.bento.redo());
  assert(await p.evaluate(() => document.getElementById('bento-fonts').textContent.includes('Review516')));
  // Changing bytes under an existing key also invalidates the font registration.
  const changed = structuredClone(custom);
  changed.assets['review-font'] = 'data:font/woff2;base64,' + fs.readFileSync(new URL('./gallery-fonts/SpaceMono-700-latin.woff2', import.meta.url)).toString('base64');
  await replace(changed);
  assert(await p.evaluate(src => document.getElementById('bento-fonts').textContent.includes(src), changed.assets['review-font']));
  await replace(original);
  await p.evaluate(() => window.fontObserver.disconnect());
  console.log('Font JSON import loads; removal, undo/redo and asset replacement refresh; unrelated edits cause zero stylesheet writes');
  assert.deepEqual(errors, []);
} finally { await browser.close() }
