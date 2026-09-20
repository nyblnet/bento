// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import type { BentoDoc, Slide } from '../model'
import { paginates } from '../model'
import { referencedAssetKeys } from '../assets'
import { copy } from '../history'

/** Only dependencies the renderer can see. Asset strings stay shared; notes,
 * comments, sync clocks and other slides' contents do not invalidate a slide. */
export function renderState(doc: BentoDoc, slide: Slide) {
  const { notes: _notes, comments: _comments, ...visual } = slide
  const refs = referencedAssetKeys({ ...doc, slides: [slide], layouts: [] })
  const at = doc.slides.indexOf(slide)
  return copy({
    visual, theme: doc.theme, size: doc.size, title: doc.title, meta: doc.meta,
    fonts: doc.fonts,
    assets: Object.fromEntries([...refs].map(k => [k, doc.assets?.[k]])),
    page: doc.slides.slice(0, at + 1).filter(s => paginates(s, doc)).length,
    pages: doc.slides.filter(s => paginates(s, doc)).length,
    clock: slide.elements.some(e => e.type === 'text' && /\{\{\s*(date|time)/i.test(e.html)) ? Math.floor(Date.now() / 1000) : 0,
  })
}
