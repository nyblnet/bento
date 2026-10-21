// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE sealed TEST document, one helper for every app (security §31): slides,
// spaces, dash, type and security's run-it check all exercise the same thing.
//
// It boots an app's TEST shell (npm run build:sealtest → dist-sealtest/, the
// only build that carries the key handoff) with the identity seal set BEFORE the
// app's own boot runs: the key is installed with addInitScript, and the kernel
// consumes it in capturePristine(), before any editor or autosave exists. Then it
// PROVES the seal took effect before a rig checks a single guard, because a
// guard check against a document that was never sealed passes vacuously.
//
//   import { openSealed, scanIndexedDB } from './lib/sealed-boot.mjs'
//   const { page, reload, close } = await openSealed(browser, 'slides', { doc })   // doc optional
//   ...edit the document, wait out the autosave debounce...
//   assert.deepEqual(await scanIndexedDB(page, MARKER), [])
//   await close()   // THROWS if the kernel store had to refuse a plaintext write:
//                   // the app's own guard is missing (use close(), not context.close())
//
// Every rig that uses it should also run its edit on an UNSEALED page
// (openSealed(browser, app, { sealed: false })) and see the marker land in
// IndexedDB: the positive control that the scan can see a leak at all.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHELLS = {
  slides: 'slides/dist-sealtest/Bento_Slides.bento.html',
  spaces: 'spaces/dist-sealtest/Bento_Spaces.bento.html',
  dash: 'dash/dist-sealtest/Bento_Dash.bento.html',
  type: 'type/dist-sealtest/Bento_Type.bento.html',
}

/** A fixed TEST document key. Never a real one: the bodies it seals are throwaway. */
export const TEST_KDOC = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)

/**
 * The test shell for an app, by explicit path. Never a release (dist-single)
 * shell. build:sealtest deletes dist-sealtest/ before it compiles and writes
 * dist-sealtest/.complete only after its last step, so a build that fails at ANY
 * step leaves nothing this accepts: a mutation that does not build can't be
 * scored against stale or half-built code (type, dash and security all hit this).
 */
export function sealtestShell(app) {
  const rel = SHELLS[app]
  if (!rel) throw new Error(`sealed-boot: no such app ${app}`)
  const url = new URL(`../../${rel}`, import.meta.url)
  if (!existsSync(url)) throw new Error(`sealed-boot: no ${rel}. Run npm run build:sealtest --prefix ${app}, and check its exit code: a failed build leaves no shell`)
  // build:sealtest touches .complete as its LAST step, after postbuild-compress:
  // a build that failed after vite wrote the shell leaves a shell but no marker
  // (security measured one: an uncompressed shell that failed a row spuriously)
  if (!existsSync(new URL('.complete', url))) throw new Error(`sealed-boot: ${rel} is from a build:sealtest that did not finish (no .complete marker). Rebuild, and check its exit code`)
  return url
}

/**
 * The test shell with a FIXED document in its #bento-doc block, written to a
 * temp file. For rigs that need the same docId across reloads (recovery is keyed
 * by docId; a fresh shell mints a new one each load). Plaintext JSON, `<`-escaped
 * as every save writes it. The seal is still applied at boot by the handoff.
 */
export function sealtestShellWith(app, doc) {
  const html = readFileSync(sealtestShell(app), 'utf8')
  const open = '<scr' + 'ipt type="application/bento+json" id="bento-doc">'
  const close = '</scr' + 'ipt>'
  const at = html.indexOf(open)
  const end = at < 0 ? -1 : html.indexOf(close, at + open.length)
  if (at < 0 || end < 0) throw new Error(`sealed-boot: no #bento-doc block in ${app}'s test shell`)
  const json = (typeof doc === 'string' ? doc : JSON.stringify(doc)).replace(/</g, '\\u003c')
  const out = join(mkdtempSync(join(tmpdir(), 'bento-sealed-')), `${app}.bento.html`)
  writeFileSync(out, html.slice(0, at + open.length) + json + html.slice(end))
  return pathToFileURL(out)
}

/**
 * Open `app`'s test shell, sealed (the default) or not. Resolves once the app has
 * booted and, when sealed, once the seal is proven: the probe says sealed, and a
 * save of the live document would write an identity-sealed envelope.
 *
 * `doc` boots a fixed document instead of the app's starter (sealtestShellWith).
 * `reload()` on the result reloads the same page, keeping its seal state, with
 * the handoff installed again and the state proven again.
 * `context` opens the page in an existing context, so it shares that context's
 * IndexedDB, and `url` reopens a file an earlier call returned. Together: an
 * unsealed session leaves a plaintext snapshot, then
 *   openSealed(browser, app, { context: first.context, url: first.url })
 * boots the SAME document SEALED on the same storage, which must refuse it.
 */
export async function openSealed(browser, app, { sealed = true, kdoc = TEST_KDOC, doc, url, context, allowStoreRefusals = false, viewport = { width: 1280, height: 900 } } = {}) {
  const ownContext = !context
  if (!context) {
    context = await browser.newContext({ viewport })
    await context.route(/^https?:/, (route) => route.abort())
  }
  const page = await context.newPage()
  // per PAGE, not per context: a second openSealed on the same context (same
  // IndexedDB) can then boot the other seal state, and no page inherits a key
  if (sealed) await page.addInitScript((k) => { globalThis.__bentoTestSeal = new Uint8Array(k) }, kdoc)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  url ??= (doc === undefined ? sealtestShell(app) : sealtestShellWith(app, doc)).href
  await page.goto(url)
  await provenState(page, app, sealed)
  // The kernel store refuses plaintext while sealed, as a BACKSTOP. An app's
  // own guard must stop the call first, so any refusal is a missing guard: a
  // sealed page fails here before it reloads or closes, unless the rig opts out
  // with { allowStoreRefusals: true } for a row that tests the backstop itself.
  const settle = async () => {
    if (!sealed || allowStoreRefusals) return
    const n = await storeRefusals(page)
    if (n !== 0) throw new Error(`sealed-boot: ${app} leaned on the kernel store's backstop ${n} time(s): one of its own plaintext guards is missing`)
  }
  const reload = async () => { await settle(); await page.reload(); await provenState(page, app, sealed) }
  const close = async () => { try { await settle() } finally { if (ownContext) await context.close(); else await page.close() } }
  return { context, page, errors, url, reload, close, settle }
}

/** How many plaintext reads or writes the kernel store has refused on this (sealed) page. */
export async function storeRefusals(page) {
  return page.evaluate(() => globalThis.__bentoTestSealProbe?.storeRefusals?.() ?? 0)
}

/** Wait for boot, then prove the seal state matches `sealed`; throw otherwise. */
async function provenState(page, app, sealed) {
  await page.waitForFunction(() => window.bento?.doc, null, { timeout: 30000 })
  const state = await page.evaluate(async () => {
    const p = globalThis.__bentoTestSealProbe
    if (!p) return { probe: false, handoffLeft: '__bentoTestSeal' in globalThis }
    let env = null
    try { env = JSON.parse(await p.body(window.bento.doc)) } catch { /* not JSON: not an envelope */ }
    return { probe: true, sealed: p.sealed(), kdf: env?.kdf ?? null, v: env?.v ?? null, handoffLeft: '__bentoTestSeal' in globalThis }
  })
  if (state.handoffLeft) throw new Error(`sealed-boot: ${app} never consumed the key handoff (is this a build:sealtest shell?)`)
  if (sealed) {
    if (!state.probe) throw new Error(`sealed-boot: ${app} has no seal probe: not a build:sealtest shell, or the seal was never consumed`)
    if (!state.sealed) throw new Error(`sealed-boot: ${app} booted but isBodySealed() is false`)
    if (state.kdf !== 'hkdf-kdoc' || state.v !== 1) throw new Error(`sealed-boot: ${app}'s save would not write an identity-sealed v1 envelope (kdf=${state.kdf}, v=${state.v})`)
  } else if (state.probe) {
    throw new Error(`sealed-boot: ${app} is sealed although no key was handed over`)
  }
}

/** What a save would write: the whole file, its suggested name, and the #bento-doc body. Sealed pages only. */
export async function savedFile(page) {
  return page.evaluate(async () => {
    const p = globalThis.__bentoTestSealProbe
    return { file: await p.file(window.bento.doc), fileName: p.fileName(window.bento.doc), body: await p.body(window.bento.doc) }
  })
}

/**
 * Every IndexedDB record in the page's origin whose JSON contains `marker`, as
 * `db/store` strings. [] means no plaintext copy of the marker is on disk.
 */
export async function scanIndexedDB(page, marker) {
  return page.evaluate(async (m) => {
    const hits = []
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter(Boolean)
    for (const name of dbs) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      for (const store of db.objectStoreNames) {
        const all = await new Promise((res, rej) => {
          const r = db.transaction(store, 'readonly').objectStore(store).getAll()
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
        })
        for (const rec of all) {
          let text
          try { text = JSON.stringify(rec) } catch { text = String(rec) }
          if (text.includes(m)) { hits.push(`${name}/${store}`); break }
        }
      }
      db.close()
    }
    return hits
  }, marker)
}
