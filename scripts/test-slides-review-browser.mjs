// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Optional browser rig: build slides first; requires Playwright and Chrome.
// CHROME_PATH may select a system browser instead of Playwright's installed one.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = fs.mkdtempSync(join(tmpdir(), 'bento-slides-review-'))
const deck = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const roundtrip = join(output, 'roundtrip.bento.html')
;(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try {
  const c=await browser.newContext({viewport:{width:1280,height:900}});
  await c.route(/^https?:/,r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const p=await c.newPage();p.on('dialog',d=>d.accept());const errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);
  await p.goto(deck);
  await p.waitForFunction(()=>window.bento?.doc);
  await p.locator('#bento-splash').waitFor({state:'detached', timeout:2500});
  await p.screenshot({path:join(output, 'desktop.jpg'),type:'jpeg',quality:65});
  // Existing Save menu owns history; existing About owns asset size/compression.
  await p.getByRole('button',{name:'Save as… — copy, new deck, password',exact:true}).click();
  await p.keyboard.press('ArrowDown');
  assert.equal(await p.evaluate(()=>document.activeElement.textContent.trim()),'Save a copy…');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.bkm-open').count(),0);
  await p.getByRole('button',{name:'Save as… — copy, new deck, password',exact:true}).click();
  await p.getByRole('menuitem',{name:'Recent changes',exact:true}).click();
  await p.getByRole('button',{name:'Done',exact:true}).click();
  await p.locator('.ed-logo').click();
  await p.getByRole('button',{name:'File size',exact:true}).click();
  assert(await p.getByRole('dialog',{name:'File size'}).isVisible());
  await p.getByRole('button',{name:'Done',exact:true}).click();
  await p.keyboard.press('ControlOrMeta+k');
  assert.equal(await p.getByRole('button',{name:'Check presentation',exact:true}).count(),0);
  await p.keyboard.press('Escape');

  assert.equal(await p.locator('.ed-save-status,.ed-tools-trigger').count(),0);
  await p.getByRole('button',{name:'Edit text and notes',exact:true}).click();
  const select=p.getByRole('dialog').getByRole('combobox');const ids=await select.locator('option').evaluateAll(els=>els.map(x=>x.value));
  await p.getByLabel('Speaker notes',{exact:true}).fill('Draft one');
  await select.selectOption(ids[1]);
  await p.getByLabel('Speaker notes',{exact:true}).fill('Draft two');
  await select.selectOption(ids[0]);
  assert.equal(await p.getByLabel('Speaker notes',{exact:true}).inputValue(),'Draft one');
  await p.getByRole('button',{name:'Apply',exact:true}).click();
  assert.deepEqual(await p.evaluate(()=>window.bento.doc.slides.slice(0,2).map(s=>s.notes)),['Draft one','Draft two']);
  await p.evaluate(()=>window.bento.undo());
  assert.notEqual(await p.evaluate(()=>window.bento.doc.slides[0].notes),'Draft one');
  await p.evaluate(()=>window.bento.redo());
  assert.equal(await p.evaluate(()=>window.bento.doc.slides[1].notes),'Draft two');
  console.log('Packaged file: multi-slide drafts apply, undo and redo passed');
  const html=await p.evaluate(()=>window.bento.serialize());
  fs.writeFileSync(roundtrip,html);
  await p.goto(pathToFileURL(roundtrip).href);
  await p.waitForFunction(()=>window.bento?.doc);
  assert.equal(await p.evaluate(()=>window.bento.doc.slides[0].notes),'Draft one');
  console.log('Packaged save and reopen preserves edits');
  await p.setViewportSize({width:390,height:844});
  await p.reload();
  await p.waitForFunction(()=>window.bento?.doc);
  await p.getByRole('button',{name:'More actions',exact:true}).click();
  await p.getByRole('menuitem',{name:'Recent changes',exact:true}).click();
  assert(await p.getByRole('dialog',{name:'Recent changes'}).isVisible());
  await p.getByRole('button',{name:'Done',exact:true}).click();
  await p.getByRole('button',{name:'Format — show or hide the properties panel',exact:true}).click();
  await p.getByRole('button',{name:'Edit text and notes',exact:true}).click();
  const geometry=await p.evaluate(()=>{
   const body=document.querySelector('.ed-document-dialog .bkd-body'),actions=document.querySelector('.ed-document-dialog .bkd-actions');
   const b=body.getBoundingClientRect(),a=actions.getBoundingClientRect();
   return {bodyBottom:b.bottom,actionsTop:a.top,actionsBottom:a.bottom,viewport:innerHeight,scroll:body.scrollHeight>body.clientHeight,overflow:getComputedStyle(body).overflowY};
  });
  assert(geometry.bodyBottom<=geometry.actionsTop);
  assert(geometry.actionsBottom<=geometry.viewport);
  assert(geometry.scroll&&geometry.overflow==='auto');
  await p.getByLabel('Speaker notes',{exact:true}).fill('Phone draft');
  await p.screenshot({path:join(output, 'phone.jpg'),type:'jpeg',quality:70});
  await p.getByRole('button',{name:'Apply',exact:true}).click();
  assert.equal(await p.evaluate(()=>window.bento.doc.slides[0].notes),'Phone draft');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('Phone: scrollable fields and visible actions passed',geometry);
  assert.deepEqual(errors,[]);
  console.log('PACKAGED BROWSER CHECKS PASSED', { output });
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
