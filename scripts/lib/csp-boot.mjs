// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE PINNED-CSP BOOT CHECK (K4, security §18 / §36 / §36a): a release must
// boot, and keep working while its UI is driven, under the script policy a
// host will serve it with:
//
//   script-src 'sha256-<loader>' 'sha256-<remover>' blob:; style-src 'unsafe-inline'
//
// Scripts are hash-pinned, the boundary. Styles are NOT pinned in phase 1
// (§36a): a document's own svg <style> can't be release-pinned (measured), and
// the sanitizer is the style control. Every refusal fails the check except the
// loader's two DESIGNED fallbacks: an inline script, then `new Function`,
// before it settles on blob:. Both are matched on directive AND source: the
// document itself, where the loader lives. A runtime path that injects any
// other script would be refused, and this check would see it.
//
// The shell is served from a fixed https origin with a real header, the way a
// host serves it (a <meta> CSP is not what hosts send). Refusals are read from
// the browser's securitypolicyviolation events, cross-checked against the
// browser's own log over CDP: Playwright's 'console' event never carries the
// CSP engine's messages (measured while building this).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { scanBlocks } from './release-pins.mjs'

export const ORIGIN = 'https://bento-pins.test'
const DOC_URL = `${ORIGIN}/doc.bento.html`

/** The policy a host serves a verified document with (the script and style axes). */
export function pinnedPolicy(pins) {
  return [`script-src ${pins.scriptSrc.map((h) => `'${h}'`).join(' ')} blob:`, "style-src 'unsafe-inline'"].join('; ')
}

/** Open `shellPath` served from ORIGIN under `policy`, with violations and the browser's log collected. */
async function servedPage(browser, shellPath, policy) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const html = readFileSync(shellPath)
  await context.route('**/*', (route) => {
    if (route.request().url() === DOC_URL) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy }, body: html })
    }
    return route.abort()
  })
  const page = await context.newPage()
  const log = []
  const cdp = await context.newCDPSession(page)
  await cdp.send('Log.enable')
  cdp.on('Log.entryAdded', ({ entry }) => { if (entry.source === 'security') log.push({ text: entry.text, level: entry.level }) })
  const violations = []
  await page.exposeBinding('__bentoPinsViolation', (_s, v) => { violations.push(v) })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      // eslint-disable-next-line no-undef
      __bentoPinsViolation({ directive: e.effectiveDirective, disposition: e.disposition, blockedURI: e.blockedURI, sourceFile: e.sourceFile, line: e.lineNumber, column: e.columnNumber })
    }, true)
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(DOC_URL)
  await page.waitForFunction(() => window.bento?.doc, null, { timeout: 30000 })
  return { context, page, log, violations, errors }
}

/**
 * Boot `shellPath` under its pins and run `drive(page)`. Returns the loader's
 * expected refusals, every OTHER refusal (`unexpected`; [] = pass) and page
 * errors. Throws if the browser's log and its violation events disagree, since
 * then neither can be trusted to have seen everything.
 */
export async function bootUnderPins(browser, shellPath, pins, drive = async (p) => { await p.waitForTimeout(2000) }) {
  const s = await servedPage(browser, shellPath, pinnedPolicy(pins))
  try {
    await drive(s.page)
    await s.page.waitForTimeout(500)
  } finally {
    await s.context.close()
  }
  // The loader is the document's own inline script, so matching on the source
  // FILE alone would excuse ANY inline script in the document (measured: an
  // injected <script> passed as "the loader's fallback"). Whole LINES aren't
  // enough either: the loader's open and close tags share lines with other
  // markup (</body> sits on its closing line), and a script injected there was
  // excused (security, measured). So a refusal is the loader's only if its
  // line AND column fall inside the loader's own text, and at most ONE of each
  // fallback is excused: the loader tries each once.
  const span = loaderSpan(readFileSync(shellPath, 'utf8'), pins.scriptSrc[0])
  const inLoader = (v) => v.sourceFile === DOC_URL && within(span, v.line, v.column)
  const expected = [], unexpected = []
  let inline = 0, evals = 0
  const enforced = s.violations.filter((v) => v.disposition === 'enforce')
  for (const v of enforced) {
    if (inLoader(v) && v.directive === 'script-src-elem' && v.blockedURI === 'inline' && inline++ === 0) expected.push(v)
    else if (inLoader(v) && v.directive === 'script-src' && v.blockedURI === 'eval' && evals++ === 0) expected.push(v)
    else unexpected.push(v)
  }
  // Chrome LOGS every refusal except an eval one (measured, Chrome 150: a
  // refused `new Function` raises an EvalError the loader catches, and only the
  // violation event records it). So the cross-check covers the logged kinds;
  // eval refusals are judged from the events alone, which do fire for them.
  const logged = s.log.filter((m) => m.level === 'error' && /Content Security Policy/.test(m.text)).length
  const loggable = enforced.filter((v) => v.blockedURI !== 'eval').length
  if (logged !== loggable) throw new Error(`csp-boot: ${loggable} non-eval refusals fired but the browser logged ${logged}: cannot judge them`)
  return { expected, unexpected, errors: s.errors }
}

/**
 * Where the PINNED loader's text sits in the served HTML, as 1-based
 * {line, column} from its first character to its last: the executable inline
 * script whose CSP hash is the pins' first script hash. Identified by its hash,
 * not by being the only script, so a doctored file with an extra script still
 * finds the real loader (and the extra script stays unexcused).
 */
export function loaderSpan(html, loaderCspHash) {
  const loaders = scanBlocks(html).filter((b) => b.tag === 'script' && b.src === null &&
    `sha256-${createHash('sha256').update(b.text, 'utf8').digest('base64')}` === loaderCspHash)
  if (loaders.length !== 1) throw new Error(`csp-boot: ${loaders.length} scripts match the pinned loader; exactly one expected`)
  const pos = (offset) => {
    const before = html.slice(0, offset)
    const line = before.split('\n').length
    return { line, column: offset - before.lastIndexOf('\n') } // 1-based
  }
  return { from: pos(loaders[0].start), to: pos(loaders[0].start + loaders[0].text.length) }
}
const after = (a, b) => a.line > b.line || (a.line === b.line && a.column >= b.column)
/** Is (line, column), 1-based, inside the span? */
const within = (span, line, column) => after({ line, column }, span.from) && after(span.to, { line, column })

// --- driving --------------------------------------------------------------------
//
// A broad first-pass DRIVER for any app: click every visible control once and
// dismiss what opened. Deliberately dumb: an app's owner adds the surfaces it
// can't reach. Never a control that destroys, publishes or leaves.
const DENY = /\b(delete|remove|stop sharing|rotate|revoke|discard|reset|sign out|publish|share link|invite|start live|go live|leave|quit|update now|install|download|save|print|export|import|replace from|open file|duplicate as new|encrypt|password)\b/i
const CONTROLS = 'button, [role="button"], [role="menuitem"], [role="tab"], summary, select, [aria-haspopup]'

/** Click each visible, enabled, not-denied control under `root` once; Escape after each. */
export async function clickEverything(page, { root = 'body', max = 400, settle = 120 } = {}) {
  const seen = new Set()
  let clicked = 0
  for (let pass = 0; pass < 3 && clicked < max; pass++) {
    const handles = await page.$$(`${root} :is(${CONTROLS})`)
    let fresh = 0
    for (const h of handles) {
      if (clicked >= max) break
      const info = await h.evaluate((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
        return { visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', label, key: `${el.tagName}|${el.className}|${label}` }
      }).catch(() => null)
      if (!info || !info.visible || info.disabled || DENY.test(info.label) || seen.has(info.key)) continue
      seen.add(info.key); fresh++
      await h.click({ timeout: 800, force: false }).catch(() => {})
      clicked++
      await page.waitForTimeout(settle)
      await page.keyboard.press('Escape').catch(() => {})
    }
    if (!fresh) break
  }
  return clicked
}
