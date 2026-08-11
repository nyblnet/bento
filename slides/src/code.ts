// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import { ThemedToken } from 'shiki'
import { Element } from 'hast'
import { BentoDoc, CodeElement } from './model';
import { sanitizeHtml } from './render';
import { getOrCreateHighlighter, HeckelDiff, Insert, State, Token, Delete, Match } from './diff';

let diff: HeckelDiff | undefined = undefined

export type RenderCodeResult = {
  /** The HTML representation when the `CodeElement` has a `grammar` and a `theme` defined. */
  html?: string,
}

/**
 * This returns the HTML representation of the `CodeElement` when the corresponding `grammar` and `theme` is defined.
 * Otherwise, it returns undefined.
 */
export function renderCode(el: CodeElement, doc: BentoDoc) {
  const mid = el.morphId
  let sanitized: string | undefined = undefined
  if (el.grammarAssetId && el.themeAssetId && el.grammarName && el.themeName) {
    const slideIdx = slideIndex(el, doc)
    const diff = getOrCreateDiff(doc)
    const map = diff.computeDiffs(mid)
    const states: State[] = map.get(slideIdx) ?? []
    const highlighter = getOrCreateHighlighter(doc, el.grammarAssetId, el.themeAssetId)
    const html = highlighter.codeToHtml(el.content, {
      // Bad typings here
      lang: el.grammarName as any,
      theme: el.themeName as any,
      includeExplanation: 'scopeName',
      mergeSameStyleTokens: false,
      transformers: [
        {
          // @ts-expect-error : We don't really need col, and lineElement
          span(hast: Element, line: number, col: number, lineElement: Element, token: ThemedToken) {
            // 0-indexed line number
            const lineNumber = line - 1
            // There should always be a matching state, but if we do intermediate renders then we
            // should still gracefully recover.
            const state = findMatchingState(states, lineNumber, token)
            if (state) {
              const id = morphId(state)
              hast.properties['data-flip-id'] = id
            } else {
              console.warn('Inconsistent States:', states, 'Line Number:', lineNumber, 'Token:', token)
            }
          },
        }
      ]
    })
    // sanitizeHtml(...) strips away all the skiki background styles.
    // That part, is great given the background no longer interferes with rendering.
    sanitized = sanitizeHtml(html)
  }
  return {
    html: sanitized
  }
}

function getOrCreateDiff(doc: BentoDoc): HeckelDiff {
  if (!diff) {
    diff = new HeckelDiff(doc)
  }
  return diff
}

/** Computes the slide index for the `CodeElement` being rendered. */
function slideIndex(el: CodeElement, doc: BentoDoc): number {
  const slides = doc.slides
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i]
    const filtered = slide.elements.filter(element => element === el)
    if (filtered && filtered.length > 0) return i
  }
  // Should never really happen
  return -1
}

function findMatchingState(states: State[], lineNumber: number, themedToken: ThemedToken): State | undefined {
  const token = Token.fromThemed(lineNumber, themedToken)
  const state = states.find((state) => {
    const kind = state.kind
    if (kind === 'empty') {
      return false
    } else if (kind === 'insert') {
      const insert = state as Insert
      return insert.token.key() === token.key() && insert.token.lineNumber === token.lineNumber && insert.token.offset === token.offset
    } else if (kind === 'delete') {
      const del = state as Delete
      return del.token.key() === token.key() && del.token.lineNumber === token.lineNumber && del.token.offset === token.offset
    } else if (kind === 'match') {
      const match = state as Match
      return match.current.key() === token.key() && match.current.lineNumber === token.lineNumber && match.current.offset === token.offset
    }
    return false
  })
  return state
}

function morphId(state: State): string {
  let id = ''
  if (state.kind === 'insert') {
    const insert = state as Insert
    id = insert.token.morphId()
  } else if (state.kind === 'delete') {
    const del = state as Delete
    id = del.token.morphId()
  } else if (state.kind === 'match') {
    const match = state as Match
    id = match.current.morphId()
  }
  return id
}
