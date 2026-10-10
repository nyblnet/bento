// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The element-writer contract: what a writer for one bento/slides element type
// receives, what it returns, and the rules it keeps. New writers (code.ts,
// embed.ts) are written against this type. The older writers (text, shapes,
// media, tables, charts) predate it and take the same things as positional
// arguments; index.ts adapts them, and nothing here asks for them to change.
//
// THE RULES. A writer:
//
//   1. Returns ONE top-level node (p:sp, p:pic or p:graphicFrame) whose
//      p:cNvPr id is ctx.shapeId, or null when it emits nothing.
//   2. Never throws on content. Anything it cannot carry exactly goes into
//      ctx.report: 'approximated' when the slide still shows something close,
//      'dropped' when it does not. One stable code per kind of loss, kebab-case
//      (e.g. 'code-colours-flattened'); the detail says what the person will
//      see in PowerPoint, in plain words. Returning null without a 'dropped'
//      entry is a silent loss, and the coverage rig fails on it.
//   3. Allocates relationships only through ctx.media (images and svg go into
//      the package that way, deduplicated by content). It never invents rIds.
//   4. Reads only the element and ctx. It imports nothing from an app: the
//      writer is a library, and the same code runs in node and in a browser.
//   5. Is deterministic: the same element and ctx give the same node, so two
//      exports of one deck are byte-identical.
//
// Link, presentation-effect and hover handling are the integrator's
// (index.ts), not the writer's: it reports effects once per slide and wires
// el.link onto whatever node the writer returns.

import type { Report } from '../report.ts'
import type { XNode } from '../xmlout.ts'
import type { MediaCtx } from './media.ts'

export interface WriteCtx {
  /** the p:cNvPr id the returned node must carry */
  shapeId: number
  /** where losses are recorded; see rule 2 */
  report: Report
  /** the report location for this element, e.g. "slide 3" */
  where: string
  /** the package's media store: images and svg enter the package through it */
  media: MediaCtx
  /** the deck theme, for writers that fall back to the deck's fonts or colours */
  theme: { background: string; color: string; accent: string; fontFamily: string }
}

/** A writer for one element type. See the rules above. */
export type ElementWriter<E> = (el: E, ctx: WriteCtx) => XNode | null

/** The frame fields every bento/slides element carries (slides/src/model.ts
 *  ElementBase, restated: the writer never imports an app). */
export interface ElFrame {
  id: string
  morphId?: string
  x: number; y: number; w: number; h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
}
