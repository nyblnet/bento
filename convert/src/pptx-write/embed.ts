// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// `embed` elements → a picture of their static view.
//
// Every embed (a bento/dash chart, a bento/type page, a web page) carries a
// static render in `view`: raw <svg> markup, or "asset:<key>" naming the asset
// that holds it. That is what PowerPoint shows, placed by svgPic (media.ts)
// with the same package wiring as any SVG. Reported as 'approximated'
// ('embed-static'): the picture travels; the live document behind it, and
// any live web frame, do not. An embed with no view (a web embed that never
// rendered one) has nothing to show and is reported dropped.

import type { ElementWriter, ElFrame } from './contract.ts'
import { svgPic } from './media.ts'

/** The fields of slides' EmbedElement a writer reads (restated from
 *  slides/src/model.ts; the writer never imports an app). */
export interface EmbedElIn extends ElFrame {
  type: 'embed'
  /** the app that made it: 'bento/dash', 'bento/type', … or 'web' */
  app: string
  /** the static render: raw <svg> markup, or "asset:<key>" holding it */
  view: string
  /** app 'web' only: the page the live frame loads */
  url?: string
}

const appName = (app: string) => (app === 'web' ? 'web page' : `${app} document`)

export const writeEmbed: ElementWriter<EmbedElIn> = (el, ctx) => {
  const view = typeof el.view === 'string' ? el.view.trim() : ''
  const asset = view.startsWith('asset:') ? view.slice('asset:'.length) : undefined
  const markup = asset ? ctx.media.assets[asset] ?? '' : view
  if (!/^<svg[\s>]/i.test(markup.trimStart())) {
    ctx.report.add('dropped', 'embed-no-view', ctx.where,
      `an embedded ${appName(el.app)} has no picture to show, so it is left out`)
    return null
  }
  const node = svgPic({ id: el.id, x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation, opacity: el.opacity, markup },
    ctx.shapeId, ctx.where, ctx.media)
  if (node) ctx.report.add('approximated', 'embed-static', ctx.where,
    `an embedded ${appName(el.app)} shows as a picture; its live content and source do not travel`)
  return node
}
