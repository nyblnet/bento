// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pictures, crops, video and audio, embeds, code.
import type { PropsPanel } from '../panels'
import { type SlideElement, type ImageElement, internAsset, type MediaElement, MEDIA_EMBED_BUDGET, type EmbedElement, type CodeElement } from '../../model'
import { section, row, segmented, number, toggle, select } from './fields'
import { t } from '../../i18n'
import { resolveAsset } from '../../render'
import { fmtBytes, shrinkImageFile, shrinkNote } from '../shrink'
import { normalizeCrop, CROP_MAX_SCALE } from '../../crop'
import { rasterView, internView } from './controls'
import { LANGS } from '../../../../kernel/src/tokenize.ts'

export function buildImageProps(p: PropsPanel, el: SlideElement) {
  section(p, t('Picture'))
  const src = (el as ImageElement).src
  // what is stored: size and pixels for an embed, the URL otherwise
  const status = document.createElement('p')
  status.className = 'ed-hint ed-status' // a state line, not help: never folded behind '?'
  const resolved = src ? resolveAsset(p.store.doc, src) : ''
  if (resolved.startsWith('data:')) {
    const bytes = Math.floor(((resolved.length - resolved.indexOf(',') - 1) * 3) / 4)
    status.textContent = t('Embedded') + ` · ${fmtBytes(bytes)}`
    const probe = new Image()
    probe.onload = () => { status.textContent = t('Embedded') + ` · ${fmtBytes(bytes)} · ${probe.naturalWidth}×${probe.naturalHeight}` }
    probe.src = resolved
  } else status.textContent = src ? t('Linked') + ` · ${src.slice(0, 60)}` : t('No picture yet')
  p.host.appendChild(status)
  // Replace: through the shrink path, or at original size (the one honest
  // way to say "I want the full-resolution file in the deck").
  const pick = (label: string, original: boolean) => {
    const b = document.createElement('button')
    b.className = 'ed-btn ed-btn-block'
    b.textContent = label
    b.addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) return
        void (original ? Promise.resolve(null) : shrinkImageFile(file)).then(async (r) => {
          const dataUrl = r ? r.dataUrl : await new Promise<string>((resolve) => { const rd = new FileReader(); rd.onload = () => resolve(String(rd.result)); rd.readAsDataURL(file) })
          const note = r && shrinkNote(r)
          if (note) p.toast(note.photo ? t('Photo stored at {px} px — {before} → {after}', note.vars) : t('Image stored at {px} px — {before} → {after}', note.vars))
          p.mutate(el.id, (e) => { (e as ImageElement).src = internAsset(p.store.doc, dataUrl) }, true)
        })
      })
      input.click()
    })
    p.host.appendChild(b)
  }
  pick(t('Replace file…'), false)
  pick(t('Replace file (original size)…'), true)
  section(p, t('Fit & corners'))
  row(p, 'Fit', segmented(['contain', 'cover', 'fill'], (el as any).fit, (v) =>
    p.mutate(el.id, (e) => { (e as any).fit = v }, true)))
  row(p, 'Corner radius', number((el as any).radius, 1, (v, fin) =>
    p.mutate(el.id, (e) => { (e as any).radius = Math.max(v, 0) }, fin), { min: 0 }))
  // Off = width and height resize independently. Unlocking also sets
  // fit:'fill' so the stretch is what the reader sees — contain/cover would
  // letterbox the distortion away. Re-locking deletes the field (absent =
  // locked, the format's default) and keeps the CURRENT shape: the next
  // resize starts from whatever ratio the frame has now.
  // proportions: the padlock between W and H (arrange.ts ratioLock) — one home for every element
  buildCropProps(p, el as ImageElement)
}

/** Crop (discussion #319): which part of the picture the frame shows. The
 *  numbers live in `crop` (model.ts ImageCrop); the canvas edits them by
 *  gesture (double-click the picture), this block offers the zoom as a
 *  number, the way in, and the way back to the whole picture. */
export function buildCropProps(p: PropsPanel, el: ImageElement) {
  section(p, t('Crop'))
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Double-click the picture to move it inside its frame; scroll or pinch to zoom.')
  p.host.appendChild(hint)
  const crop = normalizeCrop(el.crop)
  row(p, 'Zoom', number(Math.round((crop?.scale ?? 1) * 10) / 10, 0.1, (v, fin) =>
    p.mutate(el.id, (e) => {
      const im = e as ImageElement
      const scale = Math.min(CROP_MAX_SCALE, Math.max(1, Number.isFinite(v) ? v : 1))
      const cur = normalizeCrop(im.crop) ?? { x: 0.5, y: 0.5, scale: 1 }
      if (scale === 1 && cur.x === 0.5 && cur.y === 0.5) delete im.crop
      else im.crop = { ...cur, scale }
    }, fin)))
  const edit = document.createElement('button')
  edit.className = 'ed-btn ed-btn-block'
  edit.textContent = t('✎ Edit crop on canvas')
  edit.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('bento:edit-crop', { detail: { id: el.id } })))
  p.host.appendChild(edit)
  if (el.crop) {
    const reset = document.createElement('button')
    reset.className = 'ed-btn ed-btn-block'
    reset.textContent = t('Reset crop')
    reset.title = t('Show the whole picture again, the way Fit says')
    reset.addEventListener('click', () => p.mutate(el.id, (e) => { delete (e as ImageElement).crop }, true))
    p.host.appendChild(reset)
  }
}

export function buildMediaProps(p: PropsPanel, el: MediaElement) {
  section(p, t('Source & playback'))

  // source status: embedded (with size) / linked / none
  const status = document.createElement('p')
  status.className = 'ed-hint ed-status' // a state line, not help: never folded behind '?'
  // Resolve first: an embed is stored as an `asset:` ref, so testing el.src
  // directly would report an embedded clip as "linked".
  const resolved = el.src ? resolveAsset(p.store.doc, el.src) : ''
  if (!el.src) status.textContent = t('No source yet — choose a file or paste a URL.')
  else if (resolved.startsWith('data:')) {
    const kb = Math.round((resolved.length * 3) / 4 / 1024)
    status.innerHTML = t('Embedded in the file') + ` · <b>${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'}</b>`
  } else status.textContent = t('Linked — the deck stays small but needs this URL to play.')
  p.host.appendChild(status)

  // replace / choose file (embeds; warns over budget)
  const replace = document.createElement('button')
  replace.className = 'ed-btn ed-btn-block'
  replace.textContent = el.src ? t('Replace file…') : t('Choose file…')
  replace.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = el.kind === 'audio' ? 'audio/*' : 'video/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > MEDIA_EMBED_BUDGET) {
        const mb = Math.round(file.size / (1024 * 1024))
        if (!confirm(t('This file is {mb} MB. Embedding makes the .bento.html large and slow to open and save. Embed anyway?', { mb }))) return
      }
      const reader = new FileReader()
      // interned, not inline — same reason as every other embed site: only
      // doc.assets entries are reachable by the live-collab blob offload.
      reader.onload = () => p.mutate(el.id, (e) => {
        (e as MediaElement).src = internAsset(p.store.doc, String(reader.result))
      }, true)
      reader.readAsDataURL(file)
    })
    input.click()
  })
  p.host.appendChild(replace)

  // URL (reference) — clears an embed when set
  const url = document.createElement('input')
  url.type = 'text'
  url.placeholder = t('…or paste a media URL')
  url.value = el.src && !el.src.startsWith('data:') && !el.src.startsWith('asset:') ? el.src : ''
  url.addEventListener('change', () =>
    p.mutate(el.id, (e) => { (e as MediaElement).src = url.value.trim() }, true))
  row(p, 'URL', url)

  // playback
  // Labels stay RAW English — row() translates them, and looks its tooltip up
  // by the English label. Passing t(…) here would translate twice and miss
  // ROW_TIPS in every locale but English.
  const flag = (label: string, on: boolean, set: (v: boolean) => void) =>
    row(p, label, toggle(on, set))
  flag('Controls', el.controls !== false, (v) => p.mutate(el.id, (e) => { (e as MediaElement).controls = v ? undefined : false }, true))
  flag('Autoplay', !!el.autoplay, (v) => p.mutate(el.id, (e) => { (e as MediaElement).autoplay = v || undefined }, true))
  flag('Loop', !!el.loop, (v) => p.mutate(el.id, (e) => { (e as MediaElement).loop = v || undefined }, true))
  flag('Muted', !!el.muted, (v) => p.mutate(el.id, (e) => { (e as MediaElement).muted = v || undefined }, true))
  const note = document.createElement('p')
  note.className = 'ed-hint'
  note.textContent = t('Autoplay runs only while presenting; browsers require “muted” for video to autoplay.')
  p.host.appendChild(note)

  if (el.kind === 'video') {
    row(p, 'Fit', segmented(['contain', 'cover', 'fill'], el.fit ?? 'contain', (v) =>
      p.mutate(el.id, (e) => { (e as MediaElement).fit = v as MediaElement['fit'] }, true)))
    row(p, 'Corner radius', number(el.radius ?? 0, 1, (v, fin) =>
      p.mutate(el.id, (e) => { (e as MediaElement).radius = Math.max(v, 0) }, fin), { min: 0 }))
    const poster = document.createElement('input')
    poster.type = 'text'
    poster.placeholder = t('Poster image URL (optional)')
    poster.value = el.poster && !el.poster.startsWith('data:') ? el.poster : ''
    poster.addEventListener('change', () =>
      p.mutate(el.id, (e) => {
        const m = e as MediaElement
        const v = poster.value.trim()
        if (v) m.poster = v; else delete m.poster
      }, true))
    row(p, 'Poster', poster)
  }
}

/**
 * The `embed` element (model.ts EmbedElement). The view is the
 * tier that always paints; "Capture view" fills it from a picture the
 * author already has. It cannot be read off the live frame: the frame is
 * sandboxed without same-origin, so its pixels are not ours to take, and
 * that boundary is the point of the sandbox. A screenshot file is.
 */
export function buildEmbedProps(p: PropsPanel, el: EmbedElement) {
  section(p, t('Web page'))

  const status = document.createElement('p')
  status.className = 'ed-hint ed-status'
  const view = (el.view ?? '').trim()
  if (!view) status.textContent = t('No view yet. Capture a picture of the page so it shows offline.')
  else if (view.startsWith('<') || view.startsWith('asset:')) status.textContent = t('View embedded in the file')
  else status.textContent = t('View is a link. It needs the network and shows nothing offline.')
  p.host.appendChild(status)

  const capture = document.createElement('button')
  capture.className = 'ed-btn ed-btn-block'
  capture.textContent = view ? t('Replace view…') : t('Capture view…')
  capture.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/svg+xml,image/png,image/jpeg,image/webp,image/gif'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      const svg = file.type === 'image/svg+xml'
      reader.onload = () => p.mutate(el.id, (e) => {
        // an svg is the view as-is; a raster is wrapped so the view stays
        // one svg the sanitizer knows how to read (a data:image href is
        // on its allowlist). Interned, never inline: only doc.assets
        // entries reach the live-collab blob offload.
        const markup = svg ? String(reader.result) : rasterView(String(reader.result), e.w, e.h)
        ;(e as EmbedElement).view = internView(p.store.doc, markup)
      }, true)
      if (svg) reader.readAsText(file); else reader.readAsDataURL(file)
    })
    input.click()
  })
  p.host.appendChild(capture)

  // Labels stay RAW English: row() translates them and looks its tooltip
  // up by the English label (see buildMediaProps).
  const url = document.createElement('input')
  url.type = 'text'
  url.placeholder = 'https://'
  url.value = el.url ?? ''
  url.addEventListener('change', () =>
    p.mutate(el.id, (e) => {
      const m = e as EmbedElement
      const v = url.value.trim()
      if (v) m.url = v; else delete m.url
    }, true))
  row(p, 'Page URL', url)

  row(p, 'Live', toggle(!!el.live, (v) =>
    p.mutate(el.id, (e) => { (e as EmbedElement).live = v || undefined }, true)))
  const note = document.createElement('p')
  note.className = 'ed-hint'
  note.textContent = t('The live frame loads only while online. Offline mode and a missing network show the captured view instead.')
  p.host.appendChild(note)
  // Two things a presenter finds out on stage otherwise: a focused frame
  // keeps the arrow keys until they click outside it, and a live frame means
  // every viewer who presents this deck requests the page from its author —
  // the same trade a linked media src makes, said here so it is a choice.
  const trade = document.createElement('p')
  trade.className = 'ed-hint'
  trade.textContent = t('While presenting, a clicked frame keeps the arrow keys until you click outside it. Everyone who presents this deck loads the page from its site.')
  p.host.appendChild(trade)
}

export function buildCodeProps(p: PropsPanel, el: CodeElement) {
  section(p, t('Source Code'))
  const status = document.createElement('p')
  status.className = 'ed-hint ed-status' // a state line, not help: never folded behind '?'
  p.host.appendChild(status)
  // Font Size
  // Shown in POINTS (the unit office users know); the model stores slide-space
  // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
  row(p, 'Size (pt)', number(Math.round(el.fontSize * 0.75 * 10) / 10, 1, (v, fin) =>
    p.mutate(el.id, (e) => {
      (e as CodeElement).fontSize = Math.round(Math.max(v, 3) * (4 / 3) * 100) / 100
    }, fin), { min: 3 }))
  // Alignment
  row(p, 'Align', segmented(['left', 'center', 'right'], el.align, (v) =>
    p.mutate(el.id, (e) => { (e as CodeElement).align = v as CodeElement['align'] }, true)))
  // V-Alignment
  row(p, 'Vertical align', segmented(['top', 'middle', 'bottom'], el.valign, (v) =>
    p.mutate(el.id, (e) => { (e as CodeElement).valign = v as CodeElement['valign'] }, true)))
  // Line height
  row(p, 'Line height', number(el.lineHeight, 0.05, (v, fin) =>
    p.mutate(el.id, (e) => { (e as CodeElement).lineHeight = Math.max(v, 0.5) }, fin), { min: 0.5 }))
  // Language — selects the built-in tokenizer table. grammarName doubles as
  // the language id; grammarAssetId/themeAssetId stay in the format as the
  // seam for a future signed-extension tier carrying real TextMate grammars
  // as deck assets, at which point pickers for them return here.
  const langs = Object.keys(LANGS).sort().concat(['diff', 'md'])
  row(p, 'Language', select(langs, el.grammarName ?? 'js', (v) =>
    p.mutate(el.id, (e) => { (e as CodeElement).grammarName = v }, true)))
  status.textContent = t('{n} languages built in', { n: String(langs.length) })
  p.host.appendChild(status)
}
