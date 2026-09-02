// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Render bridge for code elements: kernel tokens -> HeckelDiff identities ->
// morphable spans. The diff engine (diff.ts) decides WHICH token on slide N is
// the same token as on slide N-1; this file only turns that answer into DOM.
//
// Tokens are emitted as `data-sym` spans inside the element's own
// `data-flip-id` host — the same sub-element channel the formula morph uses —
// NOT as per-token flip ids. The morph engine is model-driven: a flip id with
// no model entry is skipped by every matched-pair consumer, so per-token flip
// ids animate insertions (the entering path needs no model) but let matched
// tokens TELEPORT. data-sym offsets are measured per host on slide entry and
// tweened on exit (present.ts cacheSlideSymbols/morphMathSymbols), which is
// what makes a moved line travel.

import { BentoDoc, CodeElement } from './model'
import { HeckelDiff, type Match, type Insert, type Delete } from './diff'

/**
 * Seven colours, not four hundred scopes — the zero-cost tier. When the
 * signed-extension tier lands, grammarAssetId/themeAssetId select real
 * TextMate rendering and this map becomes the fallback.
 */
const CODE_COLORS: Record<string, string> = {
  c: '#6b7f8f', // comment
  s: '#c98a3e', // string
  n: '#b0688f', // number
  k: '#5b8def', // keyword
  f: '#3fa9a0', // call
  p: '#7c8794', // punctuation
  a: '#3f9142', // diff: added
  d: '#c25a43', // diff: removed
  x: '',        // plain: inherit the element colour
}

/**
 * Memoized per (morph group, content). The previous module-level singleton was
 * cached forever — built from the first document it saw and never invalidated,
 * so live edits kept diffing yesterday's content. Identity-keyed caching does
 * not work either: store.commit mutates the doc IN PLACE (verified — commit()
 * runs mutate() on the live object), so no object identity changes on edit.
 * The signature is the group's actual inputs, which is the only thing the
 * diff depends on; unchanged content across present-mode's repeated renders
 * still hits the cache, and any edit anywhere in the group busts it.
 */
const diffCache = new Map<string, ReturnType<HeckelDiff['computeDiffs']>>()

function diffFor(doc: BentoDoc, morphKey: string) {
  const parts: string[] = [morphKey]
  doc.slides.forEach((slide, i) => {
    for (const el of slide.elements) {
      if (el.type !== 'code') continue
      const code = el as CodeElement
      if ((code.morphId ?? code.id) !== morphKey) continue
      parts.push(`${i}\u001f${code.grammarName ?? ''}\u001f${code.content ?? ''}`)
    }
  })
  const sig = parts.join('\u001e')
  let states = diffCache.get(sig)
  if (!states) {
    if (diffCache.size > 32) diffCache.clear() // decks have few groups; stay tiny
    states = new HeckelDiff(doc).computeDiffs(morphKey)
    diffCache.set(sig, states)
  }
  return states
}

/**
 * Build the element's token spans into `pre`. Returns false when the element
 * has no content (caller falls back to plain text).
 */
export function renderCodeInto(pre: HTMLElement, el: CodeElement, doc: BentoDoc): boolean {
  const morphKey = el.morphId ?? el.id
  // REFERENCE equality, not id: the duplicate-a-slide idiom gives every twin
  // the SAME element id across slides (that is the default morph pairing), so
  // an id lookup finds the first twin and every later slide would render the
  // first slide's tokens — same text, zero travel. The element handed to the
  // renderer is the model object itself, so identity is exact. (The original
  // implementation got this right; a rewrite briefly did not.)
  const slideIdx = doc.slides.findIndex((s) => s.elements.some((e) => e === el))
  if (slideIdx < 0) return false
  const states = diffFor(doc, morphKey)
  const slideStates = states.get(slideIdx)
  if (!slideStates) return false
  for (const state of slideStates) {
    if (state.kind === 'empty') continue
    // Empty is typed { kind: string }, so kind checks cannot discriminate the
    // union — narrow by hand once it is excluded.
    const st = state as Match | Insert | Delete
    const token = st.kind === 'match' ? st.current : st.token
    const span = document.createElement('span')
    span.dataset.sym = token.morphId()
    span.textContent = token.content
    // Marks a token the morph may MOVE — styles.css gives these
    // display:inline-block, because a transform does NOTHING to a non-replaced
    // inline element (accepted, read back verbatim, zero pixels of movement).
    // Newline and whitespace tokens must stay inline: a newline inside an
    // atomic inline-level box stops breaking the line under white-space:pre.
    // diff.ts fromTok has already split multiline tokens, so ink never
    // carries a newline here.
    if (/\S/.test(token.content)) span.dataset.tok = ''
    const color = CODE_COLORS[token.scopes[0] ?? 'x']
    if (color) span.style.color = color
    const kind = token.scopes[0]
    if (kind === 'k' || kind === 'f') span.style.fontWeight = '600'
    pre.appendChild(span)
  }
  return pre.childNodes.length > 0
}
