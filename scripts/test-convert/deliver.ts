// @bundle — reaches slides' untrusted-input gate, whose imports are extensionless
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Delivery rig: what makes a converted file safe to hand someone.
//
// THE VERIFY CHAIN, WITH THE REAL CODE. kernel/src/update.ts lets a fork supply
// its own release key through configureApp({ publicKeyJwk }). This rig mints a
// throwaway P-256 keypair, signs its OWN manifest with it, and drives the real
// verifySigned + fetchPinned — so every refusal below is the production check
// refusing, not a mock agreeing. Each negative control breaks exactly one link.
//
// THE NETWORK. globalThis.fetch is replaced by a recorder serving from a map,
// so "the page only talks to the manifest and the shell" is asserted as the
// exact list of URLs requested, not inferred.

import { configureApp } from '../../kernel/src/app.ts'
import { fetchVerifiedShell, gateDoc, spliceIntoShell, extractDoc, MIN_SHELL_VERSION } from '../../convert/src/deliver.ts'
import { pptxToBento, LIMITS, LimitError } from '../../convert/src/api.ts'
import { preflight } from '../../convert/src/limits.ts'
import { writeZip } from '../../kernel/src/convert/zip.ts'
import { buildPptx, slide, sp, xfrm, fxMinimal } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
async function refuses(p: Promise<unknown>, want: RegExp, msg: string) {
  try { await p; ok(false, `${msg} (it was NOT refused)`) }
  catch (e) { ok(want.test(String((e as Error).message)), `${msg} — "${(e as Error).message}"`) }
}

// --- a throwaway release key, installed the way a fork would -----------------
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey) as { kty: 'EC'; crv: 'P-256'; x: string; y: string }
configureApp({ appId: 'bento-slides', appName: 'bento/slides', manifestUrl: 'https://rig.test/m.json',
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y } })

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
async function sign(payload: object) {
  const text = JSON.stringify(payload)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(text)))
  return JSON.stringify({ payload: text, sig: b64(sig) })
}

// A minimal but real-shaped shell: the block, a title, and other scripts whose
// close tags the splice must not disturb.
const SHELL = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>bento/slides</title>' +
  '<script type="application/bento+json" id="bento-doc"></' + 'script>' +
  '<script>/* runtime */ var a = 1</' + 'script></head><body><div id="bento-splash"></div>' +
  '<script type="bento/deflate-b64">AAAA</' + 'script></body></html>'
const shellBytes = new TextEncoder().encode(SHELL)
const pin = hex(await crypto.subtle.digest('SHA-256', shellBytes))

const requested: string[] = []
let served: Record<string, string | Uint8Array> = {}
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  requested.push(url)
  const body = served[url]
  if (body === undefined) return new Response('not here', { status: 404 })
  return new Response(body)
}) as typeof fetch

const M = 'https://rig.test/releases/slides/manifest.json'
const S = 'https://rig.test/releases/slides/Bento_Slides.bento.html'
const good = { app: 'bento-slides', version: '9.9.9', sha256: pin, url: S }

console.log('the verify chain')
served = { [M]: await sign(good), [S]: shellBytes }
requested.length = 0
const v = await fetchVerifiedShell(M)
ok(v.version === '9.9.9' && v.html === SHELL, 'a correctly signed manifest pinning the right bytes is accepted')
ok(requested.length === 2 && requested[0] === M && requested[1] === S,
  `exactly two requests, manifest then shell (got ${JSON.stringify(requested)})`)

// each negative control breaks exactly ONE link
served = { [M]: (await sign(good)).replace('9.9.9', '9.9.8'), [S]: shellBytes }
await refuses(fetchVerifiedShell(M), /signature|payload|JSON/i, 'NEGATIVE: a payload edited after signing is refused')
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
const forged = JSON.stringify({ payload: JSON.stringify(good), sig: b64(new Uint8Array(await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' }, other.privateKey, new TextEncoder().encode(JSON.stringify(good))))) })
served = { [M]: forged, [S]: shellBytes }
await refuses(fetchVerifiedShell(M), /INVALID/, 'NEGATIVE: a manifest signed by a different key is refused')
const tampered = new Uint8Array([...shellBytes, 0x20])
served = { [M]: await sign(good), [S]: tampered }
await refuses(fetchVerifiedShell(M), /signed pin/, 'NEGATIVE: one extra byte on the shell is refused')
served = { [M]: await sign({ ...good, app: 'bento-spaces' }), [S]: shellBytes }
await refuses(fetchVerifiedShell(M), /malformed/, 'NEGATIVE: a genuine manifest for ANOTHER app is refused')
served = { [M]: JSON.stringify({ payload: JSON.stringify(good) }), [S]: shellBytes }
await refuses(fetchVerifiedShell(M), /malformed/, 'NEGATIVE: an unsigned manifest is refused')

console.log('the version floor')
// A GENUINE, correctly signed and pinned release below the floor: everything
// but the version is good, so only the floor can refuse it.
const below = MIN_SHELL_VERSION.replace(/(\d+)$/, (n) => String(Number(n) - 1))
served = { [M]: await sign({ ...good, version: below }), [S]: shellBytes }
requested.length = 0
await refuses(fetchVerifiedShell(M), /older than/, `NEGATIVE: a validly signed ${below} shell is refused (floor ${MIN_SHELL_VERSION})`)
ok(requested.length === 1 && requested[0] === M, `and its shell is never downloaded (requests: ${JSON.stringify(requested)})`)
served = { [M]: await sign({ ...good, version: MIN_SHELL_VERSION }), [S]: shellBytes }
ok((await fetchVerifiedShell(M)).version === MIN_SHELL_VERSION, `the floor itself (${MIN_SHELL_VERSION}) is accepted`)
for (const odd of [`${MIN_SHELL_VERSION}-rc1`, 'latest', ''])
{
  served = { [M]: await sign({ ...good, version: odd }), [S]: shellBytes }
  await refuses(fetchVerifiedShell(M), /does not recognise/, `NEGATIVE: a non-numeric version ${JSON.stringify(odd)} is refused, not read as 0`)
}

console.log('same-origin resolution (the public page)')
served = { [M]: await sign(good), ['https://page.test/releases/slides/Bento_Slides.bento.html']: shellBytes }
requested.length = 0
const r = await fetchVerifiedShell(M, fetch, (u) => new URL(new URL(u).pathname, 'https://page.test/import/').href)
ok(r.html === SHELL && requested[1] === 'https://page.test/releases/slides/Bento_Slides.bento.html',
  'the shell is fetched from the resolved (own-origin) URL and still verified')
served = { [M]: await sign(good), ['https://page.test/releases/slides/Bento_Slides.bento.html']: tampered }
await refuses(fetchVerifiedShell(M, fetch, (u) => new URL(new URL(u).pathname, 'https://page.test/').href),
  /signed pin/, 'NEGATIVE: re-rooting the URL buys no trust — other bytes there are still refused')

console.log('the splice contract')
const { doc } = gateDoc({
  format: 'bento/slides', version: '1.0.0', title: 'A & B </' + 'script><b>', size: { width: 1280, height: 720 },
  theme: { background: '#FFFFFF', color: '#000000', accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: null, slides: [{ id: 's1', name: 'one', background: '#FFFFFF', transition: 'none', notes: '', elements: [] }],
})
const out = spliceIntoShell(SHELL, doc)
const CLOSE = '</' + 'script>'
ok(out.split(CLOSE).length === SHELL.split(CLOSE).length, 'the script-close count is unchanged')
ok(out.split('id="bento-doc"').length === 2, 'exactly one #bento-doc block')
ok(!/<\/script><b>/.test(out.slice(out.indexOf('id="bento-doc"'))), 'a title containing a close tag cannot break out of the block')
ok(JSON.stringify(extractDoc(out)) === JSON.stringify(doc), 'the block reads back as exactly the document written')
ok(/<title>A &amp; B &lt;\/script>&lt;b> — bento\/slides<\/title>/.test(out), 'the <title> is set and escaped')
let twice = ''
try { spliceIntoShell(SHELL.replace('</head>', '<script type="application/bento+json" id="bento-doc"></' + 'script></head>'), doc) }
catch (e) { twice = String((e as Error).message) }
ok(/exactly one/.test(twice), 'NEGATIVE: a shell carrying two #bento-doc blocks is refused')

console.log('the untrusted-input gate')
// Hostile strings in every attacker-controlled place the importer reads.
const EVIL = 'x" onerror="alert(1)'
const hostile = await buildPptx({
  core: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</dc:title></cp:coreProperties>',
  slides: [{
    xml: slide(sp(2, EVIL.replace(/"/g, '&quot;'),
      `<p:spPr>${xfrm(914400, 914400, 2743200, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US">' +
      '<a:latin typeface="x;}&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;"/></a:rPr>' +
      '<a:t>&lt;img src=x onerror=alert(1)&gt;&lt;/script&gt;</a:t></a:r></a:p></p:txBody>')),
  }],
})
const res = await pptxToBento(hostile, SHELL)
const block = res.html.slice(res.html.indexOf('id="bento-doc"'), res.html.indexOf(CLOSE, res.html.indexOf('id="bento-doc"')))
ok(!block.includes('<'), 'no raw "<" survives into the #bento-doc block from any hostile field')
ok(res.html.split(CLOSE).length === SHELL.split(CLOSE).length, 'hostile content adds no script-close anywhere in the file')
ok(!/<img[^>]*onerror/i.test(res.html), 'no live <img onerror> anywhere in the output')
const back = extractDoc(res.html) as { slides: Array<{ elements: Array<{ type: string; fontFamily?: string; html?: string }> }> }
const texts = back.slides.flatMap((s) => s.elements).filter((e) => e.type === 'text')
// NON-VACUOUS: every check above passes trivially on a deck with no content.
ok(texts.length === 1 && /onerror/.test(texts[0].html ?? ''),
  'the hostile text element SURVIVES, its content escaped rather than removed — the checks above tested something')
// LAYER 1 — the importer refuses to write an unsafe typeface at all.
ok(texts.length === 1 && texts[0].fontFamily === 'sans-serif',
  `the importer drops a typeface that is unsafe in CSS (got ${JSON.stringify(texts[0]?.fontFamily)})`)
ok(res.report.entries.some((e) => e.code === 'font-name-unsafe'), 'and says so in the fidelity report')
// LAYER 2 — the gate, on its own. Hand it the hostile value directly, as if the
// importer had regressed: it must still be dropped, and reported.
const direct = gateDoc({
  format: 'bento/slides', version: '1.0.0', title: 't', size: { width: 1280, height: 720 },
  theme: { background: '#FFFFFF', color: '#000000', accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: null,
  slides: [{ id: 's1', name: 'one', background: '#FFFFFF', transition: 'none', notes: '', elements: [{
    id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1, html: 'hi',
    fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', valign: 'top', lineHeight: 1.2,
    fontFamily: "'x;}</style><img src=x onerror=alert(1)>', sans-serif",
  }] }],
})
ok(direct.dropped.some((d) => /fontFamily/.test(d.path)),
  'NEGATIVE: the gate alone still drops a hostile fontFamily — the backstop holds if the importer regresses')
const clean = await pptxToBento(await fxMinimal(), SHELL)
ok(clean.gated.length === 0, 'a well-formed deck loses nothing to the gate')

console.log('limits, before anything is inflated')
const plain = await fxMinimal()
ok((() => { try { preflight(plain); return true } catch { return false } })(), 'a normal deck passes preflight')
const big = new Uint8Array(LIMITS.inputBytes + 1)
try { preflight(big); ok(false, 'NEGATIVE: an over-size input is refused') } catch (e) { ok(e instanceof LimitError, 'NEGATIVE: an over-size input is refused') }
// A real deflate bomb: 5MB of zeros compresses ~1000:1.
const bomb = await writeZip([{ name: 'ppt/zeros.xml', data: new Uint8Array(5 * 1024 * 1024) }])
try { preflight(bomb); ok(false, 'NEGATIVE: a high-ratio part is refused') }
catch (e) { ok(e instanceof LimitError && /compresses/.test((e as Error).message), `NEGATIVE: a ${Math.round(5 * 1024 * 1024 / bomb.length)}:1 part is refused before inflation`) }
const many = await writeZip(Array.from({ length: LIMITS.entries + 1 }, (_, i) => ({ name: `p${i}.xml`, data: new Uint8Array([1]) })))
try { preflight(many); ok(false, 'NEGATIVE: too many parts are refused') } catch (e) { ok(e instanceof LimitError && /parts/.test((e as Error).message), 'NEGATIVE: too many parts are refused') }
await refuses(pptxToBento(bomb, SHELL), /compresses/, 'the API applies the limits before converting')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
