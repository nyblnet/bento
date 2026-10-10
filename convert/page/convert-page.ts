// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento.page/convert — drop a file, choose what to make of it.
//
// A view over convert/src/pairs.ts: the page detects what was dropped, lists
// every conversion the table offers for it (with the reason when one applies
// but cannot run), and runs the chosen one. A new format is a new row in
// that table, not a new page.
//
// Everything happens in this tab. Files are read with the File API, converted
// by convert/src (the same code the `bento convert` CLI runs), and handed back
// as Blobs. Nothing is uploaded, and the page's CSP (scripts/build-convert-page.mjs)
// makes that a rule the BROWSER enforces: `connect-src 'self'`. The only
// requests the page makes are the signed release manifest and the shell it
// pins, and only for a conversion that builds a bento/slides deck.
//
// bento.page/import redirects here with ?from=pptx, so that its links (the
// slides menu entry, the release announcement) keep working.

import { detect, describe, optionsFor, nothingFor, LimitError, type Detected, type Conversion, type Env } from '../src/pairs.ts'
import { fetchVerifiedShell, LIMITS } from '../src/api.ts'
import { foldReport, type FidelityReport } from '../src/report.ts'
import { loadDocJson } from './load-json.ts'
import { rasteriseToPng } from './rasterise.ts'
import { SAMPLE_DECK, SAMPLE_DECK_NAME } from './sample-deck.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = $<HTMLInputElement>('file')
const drop = $('drop')
const status = $('status')
const result = $('result')
const choose = $('choose')
const options = $('options')
const convertBtn = $<HTMLButtonElement>('convert')

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// engine messages start lowercase because they are written to follow a colon
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

$('limit').textContent = mb(LIMITS.inputBytes)

// Arriving from bento.page/import: say what that page said.
if (new URLSearchParams(location.search).get('from') === 'pptx') {
  $('title').textContent = 'Open a PowerPoint deck in bento/slides'
  $('lede').textContent = 'Turn a .pptx into a bento/slides deck: one HTML file that edits and presents itself in any browser, with nothing to install.'
  $('drop-title').textContent = 'Drop a .pptx here, or choose one'
}

function say(text: string, kind: 'busy' | 'error' | 'idle' = 'busy') {
  status.textContent = text
  status.dataset.kind = kind
  status.hidden = false
}

// A verified shell is fetched once per page load and reused. A refused shell
// is forgotten, never retried into a fallback.
let shell: Promise<{ version: string; html: string }> | null = null
const env: Env = {
  shell() {
    say('Fetching the latest bento/slides and checking its signature…')
    // Both requests go to THIS origin: the manifest by relative path, and the
    // shell by re-rooting the signed URL's path here (deliver.ts `resolve`).
    // That is what lets the CSP be `connect-src 'self'` with no exceptions.
    shell ??= fetchVerifiedShell('/releases/slides/manifest.json', fetch,
      (u) => new URL(new URL(u).pathname, location.href).href)
    return shell
  },
  loadDocJson,
  rasterise: rasteriseToPng,
}

let current: Detected | null = null
let urls: string[] = []
let busy = false

function reset() {
  for (const u of urls) URL.revokeObjectURL(u)
  urls = []
  result.hidden = true
  result.innerHTML = ''
  status.hidden = true
}

async function take(name: string, bytes: Uint8Array) {
  if (busy) return
  reset()
  current = null
  choose.hidden = true
  if (bytes.length > LIMITS.inputBytes)
    return say(`That file is ${mb(bytes.length)}. This page takes files up to ${mb(LIMITS.inputBytes)}.`, 'error')
  const d = detect(name, bytes)
  const info = describe(d)
  $('source').hidden = false
  $('source-title').textContent = info.title
  $('source-meta').textContent = info.meta
  const opts = optionsFor(d)
  if (!opts.length) return say(nothingFor(d), 'error')
  current = d
  options.innerHTML = opts.map((o, i) => `
    <label class="option${o.ok ? '' : ' off'}">
      <input type="radio" name="to" value="${esc(o.conversion.id)}"${o.ok ? '' : ' disabled'}${o.ok && i === opts.findIndex((x) => x.ok) ? ' checked' : ''}>
      <span><b>${esc(o.conversion.label)}</b>${esc(o.ok ? o.conversion.hint : o.why)}${o.ok ? (o.conversion.flags ?? []).filter((f) => f.applies(d)).map((f) => `
        <span class="flag"><input type="checkbox" data-flag="${esc(o.conversion.id)}:${esc(f.id)}"> ${esc(f.label)}</span>`).join('') : ''}</span>
    </label>`).join('')
  choose.hidden = false
  convertBtn.disabled = !opts.some((o) => o.ok)
}

async function run() {
  if (!current || busy) return
  const id = (options.querySelector('input[name=to]:checked') as HTMLInputElement | null)?.value
  const c = optionsFor(current).find((o) => o.ok && o.conversion.id === id)?.conversion
  if (!c) return
  busy = true
  convertBtn.disabled = true
  reset()
  try {
    say(`Converting ${current.name}…`)
    const flags: Record<string, boolean> = {}
    for (const box of options.querySelectorAll<HTMLInputElement>(`input[data-flag^="${c.id}:"]`)) flags[box.dataset.flag!.split(':')[1]] = box.checked
    const r = await c.run(current, env, flags)
    status.hidden = true
    show(c, r.fileName, r.mime, r.bytes, r.report, r.stats, r.meta)
  } catch (err) {
    if (c.network) shell = null
    const msg = err instanceof LimitError
      ? `This file was refused: ${err.message}.`
      : /signature|pin|manifest|release server/i.test(String((err as Error)?.message))
        ? `Could not verify the bento/slides release, so nothing was produced. ${cap((err as Error).message)}.`
        : `This file could not be converted: ${(err as Error)?.message ?? String(err)}.`
    say(msg, 'error')
  } finally {
    busy = false
    convertBtn.disabled = false
  }
}

// The report, in words a person can act on. Engine `detail` strings are
// written for developers; codes listed here are said plainly instead, and
// any code not listed falls back to the engine's own words, never silence.
const PLAIN: Record<string, string> = {
  'table-not-yet': 'Tables are not converted yet. A placeholder box marks where each one was.',
  'chart-not-yet': 'Charts are not converted yet. A placeholder box marks where each one was.',
  'text-needs-refit': 'Some text boxes may need resizing, because this device’s fonts differ slightly from the original’s.',
  'font-substituted': 'Some fonts were not included in the file, so a similar font is used instead.',
  'paragraph-spacing-dropped': 'Extra space between paragraphs is not kept.',
  'run-formatting-flattened': 'Mixed formatting inside a text box (different colours or sizes) is simplified.',
  'bullet-flattened': 'Bullet styles are simplified.',
  'auto-number-frozen': 'Numbered lists keep their numbers, but no longer renumber automatically.',
  'field-frozen': 'Slide numbers and dates are kept as plain text.',
  'image-crop-dropped': 'Cropped pictures show in full.',
  'image-external-dropped': 'Pictures linked from the web are left out. This page never downloads them.',
  'effect-dropped': 'Some visual effects (glows, reflections, 3-D) are left out.',
  'flip-dropped': 'Flipped shapes and pictures appear unflipped.',
  'picture-fill-dropped': 'Shapes filled with a picture are left empty.',
  'background-image-dropped': 'Slide background pictures are left out.',
  'nested-group-flattened': 'Groups inside groups are flattened into one group.',
  'state-slides-omitted': 'Interactive states (slides reached by clicking) are left out. Links to them go to the slide they belong to.',
  'morph-not-exported': 'Morph transitions become plain cuts.',
  'presentation-effects-static': 'Animations and reveal steps show their final frame.',
  'hover-static': 'Hover effects are static: everything on the slide shows.',
  'element-unsupported': 'Some elements have no PowerPoint equivalent yet and are left out.',
  'maths-as-source': 'Formulas appear as their LaTeX source, because PowerPoint does not typeset them.',
  'fonts-not-embedded': 'The deck’s own fonts are not included. Install them where the PowerPoint file is opened, or PowerPoint uses another font.',
  'svg-no-raster-fallback': 'Vector artwork shows in PowerPoint 2019 and later, and in PowerPoint for the web; PowerPoint 2016 shows an empty frame.',
  'media-dropped': 'Audio and video do not play in the PowerPoint file. A video’s poster picture stands in.',
  'text-field-pad-lost': 'Page numbers update in PowerPoint, but lose their leading zeros.',
  'multiple-shadows-simplified': 'Where a shape has several shadows, only the first is kept.',
  'table-radius-dropped': 'Rounded table corners become square.',
  'line-tip-approximated': 'Some line ends are drawn with the closest PowerPoint arrowhead.',
  'value-removed': 'Values the bento/slides format does not allow were removed.',
  'states-as-hidden-slides': 'Interactive states are hidden slides, right after the slide they belong to. Links still lead to them, and the show skips them.',
  'image-converted-png': 'WebP and similar pictures were converted to PNG for PowerPoint. They look the same; the file is a little larger.',
  'text-height-provisional': 'Some text boxes had no height, so they start one line tall. Select one in bento/slides and use Fit height to text.',
}

function show(c: Conversion, name: string, mime: string, bytes: Uint8Array, report: FidelityReport,
  stats: Array<{ label: string; value: number }>, meta?: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const rep = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
  urls.push(url, rep)
  const rows = foldReport(report).map((e) => `
    <li class="${esc(e.verdict)}"><span class="tag">${e.verdict === 'dropped' ? 'Not carried' : 'Approximated'}</span>${esc(PLAIN[e.code] ?? cap(e.detail))}${e.where ? ` <span class="where">· ${esc(e.where)}</span>` : ''}${e.count > 1 ? ` <span class="n">×${e.count}</span>` : ''}</li>`).join('')
  const toPptx = c.id.endsWith('-to-pptx')
  result.innerHTML = `
    <h2>${esc(name)}</h2>
    ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    <div class="stats">${stats.map((s) => `<div><strong>${s.value}</strong><span>${esc(s.label)}</span></div>`).join('')}</div>
    <div class="actions">
      <a class="btn" id="download" href="${url}" download="${esc(name)}">Download ${esc(name)}</a>
      <a id="report-json" href="${rep}" download="${esc(name.replace(/\.[^.]+$/, ''))}.report.json">Save the list as JSON</a>
    </div>
    ${rows
      ? `<p class="meta">These did not come across exactly, so check them before you share it:</p><ul class="report">${rows}</ul>`
      : '<p class="meta">Everything the converter looked at came across.</p>'}
    ${toPptx ? `<p class="nudge"><strong>Sharing with someone?</strong> You can send the .bento.html itself.
      It opens in any browser, with nothing to install, and keeps its animations, morphs and interactive states, which PowerPoint does not.</p>`
      : '<p class="meta">Open it in any browser to edit and present. Save once in bento/slides and it gets its file thumbnail.</p>'}`
  result.hidden = false
}

input.addEventListener('change', async () => {
  const f = input.files?.[0]
  input.value = ''
  if (f) await take(f.name, new Uint8Array(await f.arrayBuffer()))
})
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') })
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'))
drop.addEventListener('drop', async (e) => {
  e.preventDefault()
  const files = (e as DragEvent).dataTransfer?.files
  if (!files?.length) return
  if (files.length > 1) return say('Drop one file at a time.', 'error')
  await take(files[0].name, new Uint8Array(await files[0].arrayBuffer()))
})
// A file dropped anywhere else must not navigate the tab away from the page.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())
$('sample').addEventListener('click', () => void take(SAMPLE_DECK_NAME, new TextEncoder().encode(SAMPLE_DECK)))
convertBtn.addEventListener('click', () => void run())
