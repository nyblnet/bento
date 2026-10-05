// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento.page/import — drop a .pptx, get a .bento.html back.
//
// Everything happens in this tab. The file is read with the File API, converted
// by convert/src/api.ts (the same composition the CLI runs), and handed back as
// a Blob. Nothing is uploaded, and the page's CSP (scripts/build-import-page.mjs)
// makes that a property the BROWSER enforces rather than one this code promises:
// `connect-src 'self'` — the only requests this page can make are to bento.page,
// and the only two it does make are the signed release manifest and the shell
// that manifest pins.
//
// The shell is verified before anything is written into it (signature over the
// pin, pin over the bytes — deliver.ts). A shell that fails is refused and the
// visitor is told so; there is no download from an unverified shell.

import { fetchVerifiedShell, pptxToBento, LimitError, LIMITS } from '../src/api.ts'
import type { FidelityReport } from '../src/report.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const drop = $<HTMLElement>('#drop')
const input = $<HTMLInputElement>('#file')
const status = $<HTMLElement>('#status')
const result = $<HTMLElement>('#result')

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
// engine messages start lowercase because they are written to follow a colon
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

$<HTMLElement>('#limit').textContent = mb(LIMITS.inputBytes)

function say(text: string, kind: 'busy' | 'error' | 'idle' = 'busy') {
  status.textContent = text
  status.dataset.kind = kind
  status.hidden = false
}

// A verified shell is fetched once per page load and reused: converting three
// decks does not ask the release server three times.
let shell: Promise<{ version: string; html: string }> | null = null

async function convert(file: File) {
  result.hidden = true
  result.innerHTML = ''
  if (!/\.pptx$/i.test(file.name)) return say('That is not a .pptx file. Choose a PowerPoint presentation.', 'error')
  if (file.size > LIMITS.inputBytes)
    return say(`That file is ${mb(file.size)}. This page takes presentations up to ${mb(LIMITS.inputBytes)}.`, 'error')
  try {
    say('Fetching the latest bento/slides and checking its signature…')
    // Both requests go to THIS origin: the manifest by relative path, and the
    // shell by re-rooting the signed URL's path here (deliver.ts `resolve`).
    // That is what lets the CSP be `connect-src 'self'` with no exceptions.
    shell ??= fetchVerifiedShell('/releases/slides/manifest.json', fetch,
      (u) => new URL(new URL(u).pathname, location.href).href)
    const s = await shell
    say(`Converting ${file.name}…`)
    const res = await pptxToBento(new Uint8Array(await file.arrayBuffer()), s.html)
    const name = file.name.replace(/\.pptx$/i, '') + '.bento.html'
    const url = URL.createObjectURL(new Blob([res.html], { type: 'text/html' }))
    status.hidden = true
    showResult(name, url, res.slides, s.version, res.report, res.gated.length)
  } catch (err) {
    // A refused shell must stay refused for this page load: never retry into a
    // fallback, and never keep a rejected promise that later looks settled.
    shell = null
    const msg = err instanceof LimitError
      ? `This file was refused: ${err.message}.`
      : /signature|pin|manifest|release server/i.test(String((err as Error)?.message))
        ? `Could not verify the bento/slides release, so nothing was produced. ${cap((err as Error).message)}.`
        : `This file could not be converted: ${(err as Error)?.message ?? String(err)}.`
    say(msg, 'error')
  }
}

// The report, in words a visitor can act on. The engine's `detail` strings are
// written for developers ("spcBef/spcAft have no bento equivalent"); the brief
// for this page is to say what did not come across PLAINLY. Codes not listed
// here fall back to the engine's own detail rather than to silence.
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
}

function showResult(name: string, url: string, slides: number, version: string, r: FidelityReport, gated: number) {
  // One line per KIND of loss. The engine folds findings per (code, where) —
  // right for a developer locating a problem, noise for a visitor, who would
  // read "extra space between paragraphs is not kept" once per text box.
  const byCode = new Map<string, { verdict: string; code: string; detail: string; count: number }>()
  for (const e of r.entries) {
    if (e.verdict === 'carried') continue
    const seen = byCode.get(e.code)
    if (seen) seen.count += e.count
    else byCode.set(e.code, { verdict: e.verdict, code: e.code, detail: e.detail, count: e.count })
  }
  // not-carried first: those are the ones worth checking before anything else
  const lossy = [...byCode.values()].sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'dropped' ? -1 : 1))
  const rows = lossy.map((e) => `
    <li class="${e.verdict}"><span class="tag">${e.verdict === 'dropped' ? 'Not carried' : 'Approximated'}</span>
      ${esc(PLAIN[e.code] ?? e.detail)}${e.count > 1 ? ` <span class="n">×${e.count}</span>` : ''}</li>`).join('')
  result.innerHTML = `
    <h2>${esc(name)}</h2>
    <p class="meta">${slides} slide${slides === 1 ? '' : 's'} · built on bento/slides ${esc(version)}, signature verified</p>
    ${lossy.length
      ? `<p>Most of your deck came across. These did not come across exactly, so check them after you open it:</p><ul class="report">${rows}</ul>`
      : '<p>Everything the converter looked at came across.</p>'}
    ${gated ? `<p class="meta">${gated} value${gated === 1 ? '' : 's'} the bento/slides format does not allow were removed.</p>` : ''}
    <a class="btn" href="${url}" download="${esc(name)}">Download ${esc(name)}</a>
    <p class="meta">Open it in any browser to edit and present. Save once in bento/slides and it gets its file thumbnail.</p>`
  result.hidden = false
}

input.addEventListener('change', () => { if (input.files?.[0]) void convert(input.files[0]) })
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer?.files?.[0]
  if (f) void convert(f)
})
