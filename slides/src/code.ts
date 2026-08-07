// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import { Highlighter, createHighlighter, createJavaScriptRegexEngine } from 'shiki'
import { BentoDoc, CodeElement } from './model';
import { sanitizeHtml } from './render';

const highlighters: Map<string, Highlighter> = new Map()

// Use the browser JavaScript Engine to avoid shipping more WASM and bloating the runtime.
const engine = createJavaScriptRegexEngine()


export async function renderCode(el: CodeElement, doc: BentoDoc): Promise<string | undefined> {
  if (el.grammarAssetId && el.themeAssetId && el.grammarName && el.themeName) {
    const highlighter = await getOrCreateHighlighter(doc, el.grammarAssetId, el.themeAssetId)
    const html = highlighter.codeToHtml(el.content, {
      // Bad typings here
      lang: el.grammarName as any,
      theme: el.themeName as any
    })
    return sanitizeHtml(html)
  } else {
    return undefined
  }
}

async function getOrCreateHighlighter(doc: BentoDoc, grammarId: string, themeId: string): Promise<Highlighter> {
  const key = `${themeId}/${grammarId}`
  let highlighter = highlighters.get(key)
  if (!!highlighter) return highlighter
  const assets = doc.assets ?? {}
  const grammar = JSON.parse(assets[grammarId])
  const theme = JSON.parse(assets[themeId])
  highlighter = await createHighlighter({
    langs: [grammar],
    themes: [theme],
    engine: engine
  })
  // Highlighters are expensive to create. Keep them around and call dispose() when done.
  highlighters.set(key, highlighter)
  return highlighter
}
