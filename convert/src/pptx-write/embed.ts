// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// `embed` elements → PowerPoint. NOT YET WRITTEN: today an embed (a bento/dash
// chart, a bento/type page, a web page) is reported as dropped and nothing is
// emitted. This file is the place to write it; convert/CONTRIBUTING.md has the
// walkthrough.
//
// Every embed carries a static render in `view`: raw <svg> markup, or
// "asset:<key>" naming the asset that holds it. That is what PowerPoint should
// show. svgPic in media.ts already turns svg markup into a picture with the
// right package wiring, so a first version can hand it the view and report
// 'approximated' ('embed-static'): the slide shows the picture, but the live
// document behind it does not travel. A web embed (app 'web') with no view
// stays dropped.
//
// When it emits something, move 'embed' from NOT_YET to MAPPED in
// scripts/test-convert/pptx-coverage.ts, and add its own checks there.

import type { ElementWriter, ElFrame } from './contract.ts'

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

export const writeEmbed: ElementWriter<EmbedElIn> = (_el, ctx) => {
  ctx.report.add('dropped', 'element-unsupported', ctx.where, "element type 'embed' has no pptx mapping")
  return null
}
