// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Export slides as images — the pixels. The decisions (which slides, names,
 * matte, size) are in ../exportimages.ts; this file turns a slide into a PNG
 * or JPEG and hands the files to the browser.
 *
 * HOW A SLIDE BECOMES PIXELS. The same renderer everything else uses,
 * `renderSlide` in the mode the sidebar thumbnails and print use (`svgAsImage`,
 * `hidePlaceholders`), serialised as XHTML inside an SVG `<foreignObject>`,
 * loaded as an image and drawn onto a canvas at 1× or 2× the deck's size. The
 * SVG carries its own stylesheet: the runtime's `.bento-*` rules read back from
 * the live document (the deck's stylesheet, not a second copy), and the deck's
 * `@font-face` rules (data: URIs — embedded fonts and the built-in faces), so
 * text draws in the deck's own type. Nothing here is tiered by PREVIEW_BUDGET:
 * a file on disk is not a thumbnail, and it gets the full render.
 *
 * WHAT THE STATIC RENDER CANNOT HOLD, stated so the limits are honest:
 * charts draw from `chartSnapshotSvg` (the still the thumbnails use, not the
 * live chart); video and audio draw as their poster or icon; an embed draws as
 * its placeholder card; an image whose src is an http(s) URL draws blank — an
 * SVG loaded as an image may not fetch, and a canvas that had would be
 * tainted and refuse to export anyway.
 *
 * FILES. No ZIP writer (bytes). One file per page: the current slide is one
 * download; "all" writes into a folder through showDirectoryPicker where the
 * browser has it (Chromium — the same API in-place save uses), falls back to
 * one download per page elsewhere, and on Safari, which has neither a
 * directory picker nor dependable multi-file downloads, says plainly that only
 * the current slide can be exported there.
 */

import { renderSlide } from '../render'
import { createDialog } from '../../../kernel/src/ui/dialog.ts'
import '../../../kernel/src/ui/dialog.css'
import { t } from '../i18n'
import type { BentoDoc, Slide } from '../model'
import {
  IMAGE_FORMATS, IMAGE_SCALES, exportBase, exportFileName, exportableSlides, matteFor, mimeOf, pixelSize,
  type ImageFormat, type ImageScale,
} from '../exportimages'

/** The runtime rules the rendered slide relies on, read from the live page:
 *  every `.bento-*` style rule that is not editor, present or speaker chrome. */
function runtimeCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText.includes('.bento-') && !/\.ed-|\.reveal|\.sv-|\.bp-/.test(r.selectorText)) out.push(r.cssText)
    }
  }
  return out.join('\n')
}

/** Draw one slide at `scale` and encode it. Rejects (SecurityError) when the
 *  canvas is tainted — see the header for when that happens. */
export async function rasterizeSlide(doc: BentoDoc, slide: Slide, format: ImageFormat, scale: ImageScale): Promise<Blob> {
  const { width: w, height: h } = doc.size
  const { width: pw, height: ph } = pixelSize(doc, scale)
  const surface = renderSlide(slide, doc, { svgAsImage: true, hidePlaceholders: true })
  const css = runtimeCss() + '\n' + (document.getElementById('bento-fonts')?.textContent ?? '')
  const xhtml = new XMLSerializer().serializeToString(surface)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml">` +
    `<style><![CDATA[${css}]]></style>${xhtml}</div></foreignObject></svg>`
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = pw
  canvas.height = ph
  const ctx = canvas.getContext('2d')!
  const matte = matteFor(format)
  if (matte) { ctx.fillStyle = matte; ctx.fillRect(0, 0, pw, ph) }
  ctx.drawImage(img, 0, 0, pw, ph)
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), mimeOf(format), 0.92)
    } catch (e) { reject(e) }
  })
}

/** The anchor-click download the kernel's save fallback uses, for a binary
 *  blob (the kernel's takes HTML text). Never retains a file handle. */
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

type DirHandle = { getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> }
const dirPicker = (): (() => Promise<DirHandle>) | undefined =>
  (window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> }).showDirectoryPicker
const isSafari = () => /safari/i.test(navigator.userAgent) && !/chrome|chromium|android|edg/i.test(navigator.userAgent)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Export the current slide, or every linear slide, per the dialog's choices. */
export async function exportImages(
  doc: BentoDoc, current: Slide, format: ImageFormat, scale: ImageScale, all: boolean, toast: (msg: string) => void,
) {
  const base = exportBase(doc)
  const pages = exportableSlides(doc)
  const encode = (s: Slide) => rasterizeSlide(doc, s, format, scale)
  try {
    if (!all) {
      const n = Math.max(1, pages.indexOf(current) + 1)
      downloadBlob(await encode(current), exportFileName(base, n, format))
      return
    }
    const pick = dirPicker()
    if (pick) {
      let dir: DirHandle
      try { dir = await pick() } catch { return } // cancelled
      for (let i = 0; i < pages.length; i++) {
        const fh = await dir.getFileHandle(exportFileName(base, i + 1, format), { create: true })
        const w = await fh.createWritable()
        await w.write(await encode(pages[i]))
        await w.close()
      }
      toast(t('Exported {n} pages to the folder', { n: pages.length }))
      return
    }
    if (isSafari()) {
      // one download is dependable here; a burst is not, and there is no picker
      downloadBlob(await encode(current), exportFileName(base, Math.max(1, pages.indexOf(current) + 1), format))
      toast(t('Safari can export the current slide only — each page is one download here'))
      return
    }
    for (let i = 0; i < pages.length; i++) {
      downloadBlob(await encode(pages[i]), exportFileName(base, i + 1, format))
      await wait(400) // let the browser's download prompt keep up
    }
    toast(t('Exported {n} pages', { n: pages.length }))
  } catch (e) {
    // a tainted canvas: an element draws from a URL on the web
    if ((e as { name?: string }).name === 'SecurityError') toast(t('This slide links to an image on the web, which cannot be drawn into a file'))
    else throw e
  }
}

/** The three-control dialog: format, scale, this slide or all. */
export function openExportImagesDialog(doc: BentoDoc, current: Slide, toast: (msg: string) => void) {
  const body = document.createElement('div')
  const select = (label: string, pairs: Array<[string, string]>, value: string) => {
    const row = document.createElement('label')
    row.className = 'ed-row'
    const span = document.createElement('span')
    span.textContent = label
    const sel = document.createElement('select')
    for (const [v, text] of pairs) {
      const o = document.createElement('option')
      o.value = v; o.textContent = text; o.selected = v === value
      sel.appendChild(o)
    }
    row.append(span, sel)
    body.appendChild(row)
    return sel
  }
  const what = select(t('Slides'), [['current', t('This slide')], ['all', t('All slides in the show')]], 'current')
  const fmt = select(t('Format'), IMAGE_FORMATS.map((f) => [f, f === 'png' ? 'PNG' : 'JPEG']), 'png')
  const sc = select(t('Size'), IMAGE_SCALES.map((s) => [String(s), `${s}× (${pixelSize(doc, s).width}×${pixelSize(doc, s).height})`]), '2')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('One file per slide, named after the deck; hidden slides and states stay out, as in a PDF.')
  body.appendChild(hint)

  const cancel = document.createElement('button')
  cancel.className = 'ed-btn'
  cancel.textContent = t('Cancel')
  const go = document.createElement('button')
  go.className = 'ed-btn ed-primary'
  go.textContent = t('Export')
  const dlg = createDialog({ title: t('Export slides as images'), content: body, actions: [cancel, go] })
  cancel.addEventListener('click', () => dlg.close())
  go.addEventListener('click', () => {
    dlg.close()
    void exportImages(doc, current, fmt.value as ImageFormat, Number(sc.value) as ImageScale, what.value === 'all', toast)
  })
  dlg.open()
}
