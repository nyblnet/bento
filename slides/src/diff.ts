// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

// https://shiki.style/guide/best-performance#fine-grained-bundle
// When importing Shiki dependencies, be _very careful_ to not import things from the bundled namespaces.
// Otherwise the runtime costs are huge.
import { ThemedToken, createHighlighterCoreSync, HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { BentoDoc, Slide } from "./model"

// Preamble

const highlighters: Map<string, HighlighterCore> = new Map()

const engine = createJavaScriptRegexEngine()

/** Also used to render the actual code snippets. */
export function getOrCreateHighlighter(doc: BentoDoc, grammarId: string, themeId: string): HighlighterCore {
  const key = `${themeId}/${grammarId}`
  let highlighter = highlighters.get(key)
  if (!!highlighter) return highlighter
  const assets = doc.assets ?? {}
  const grammar = JSON.parse(assets[grammarId])
  const theme = JSON.parse(assets[themeId])
  highlighter = createHighlighterCoreSync({
    langs: [grammar],
    themes: [theme],
    engine: engine
  })
  // Highlighters are expensive to create. Keep them around and call dispose() when done.
  highlighters.set(key, highlighter)
  return highlighter
}

// The stable token that we can diff between slides.

export class Token {

  /* The morph id. */
  _id: string | undefined

  constructor(
    public readonly content: string,
    public readonly scopes: Array<string>,
    public readonly lineNumber: number,
    public readonly offset: number,
  ) {
    this._id = undefined
  }

  morphId(): string {
    return this._id!
  }

  setMorphId(id: string) {
    this._id = id
  }

  depth(): number {
    return this.scopes.length
  }

  key(): string {
    const json = {
      content: this.content,
      scopes: this.scopes,
      depth: this.depth()
    }
    return JSON.stringify(json)
  }

  static fromThemed(lineNumber: number, token: ThemedToken): Token {
    const content = token.content
    const explanations = token.explanation
    const offset = token.offset
    const scopes = new Set<string>()
    if (explanations) {
      for (const explanation of explanations) {
        for (const scope of explanation.scopes) {
          scopes.add(scope.scopeName)
        }
      }
    }
    return new Token(content, [...scopes], lineNumber, offset)
  }
}

// Diff states

/** Initial diff state. */
export const Empty = { kind: 'empty' }

/** Match */

export type Match = {
  kind: 'match',
  previousIdx: number,
  previous: Token,
  current: Token,
  currentIdx: number,
}

/** Insert */

export type Insert = {
  kind: 'insert',
  token: Token,
  index: number,
}

/** Delete */

export type Delete = {
  kind: 'delete',
  token: Token,
  index: number,
}

/** Discriminated Union of all diff states. */

export type State = typeof Empty | Match | Insert | Delete

/** Diff algorithm. */

export class HeckelDiff {

  /** A counter for morph ids. */
  static count: number = 0

  constructor(private readonly doc: BentoDoc) {

  }

  /**
   * @returns a `Map` of `states` grouped by `slideIdx` for a given morph id (`mid`).
   */
  public computeDiffs(mid: string | undefined): Map<number, State[]> {
    // Output
    let states: Map<number, State[]> = new Map<number, State[]>()
    const slides = this.doc.slides
    // Parse the slides only once
    // Parsed is a 2-D array. First indexed by the slideIndex, then flattened tokens.
    const parsed: Array<Token[]> = []
    for (const slide of slides) {
      const tokens = HeckelDiff.parse(this.doc, slide, mid)
      parsed.push(tokens)
    }
    // For all the tokens in the first code slide, assign them stable ids.
    const firstIdx = HeckelDiff.zipIndex(0, parsed)
    let tokens: Token[] = []
    if (firstIdx) {
      // Reset counts before recomputing stable ids
      HeckelDiff.count = 0
      tokens = parsed[firstIdx]
      for (const token of tokens) {
        token.setMorphId(HeckelDiff.generateMorphId())
      }
      states.set(firstIdx, HeckelDiff.tokensAsState(tokens))
    }
    // Find slide pairs to diff.
    const zipped = HeckelDiff.zip(parsed)
    if (zipped.length > 0) {
      for (const entry of zipped) {
        // Flatten to 1-D to make the diffing easier
        const previous = parsed[entry[0]]
        const current = parsed[entry[1]]
        const [_, statesC] = HeckelDiff.computeDiff(previous, current)
        states.set(entry[1], statesC)
      }
    }
    return states
  }

  static generateMorphId(): string {
    this.count += 1
    return `m-code-token-${this.count}`
  }

  private static parse(doc: BentoDoc, slide: Slide, mid: string|undefined): Token[] {
    const tokens: Token[] = []
    for (const el of slide.elements) {
      if (el.type === 'code' && el.grammarAssetId && el.themeAssetId && el.morphId === mid) {
        const highlighter = getOrCreateHighlighter(doc, el.grammarAssetId, el.themeAssetId)
        // We need to be able to parse the tokens in the *exact* same way in which we would when
        // calling codeToHtml() in the render step. So rather than call `codeToTokens()` or a similar
        // API here, we instead accumulate tokens using a transformer.
        let allTokens: ThemedToken[][] = []
        highlighter.codeToHtml(el.content, {
          lang: el.grammarName as any,
          theme: el.themeName as any,
          includeExplanation: 'scopeName',
          mergeSameStyleTokens: false,
          transformers: [
            {
              tokens(tokens: ThemedToken[][]) {
                allTokens = tokens
              },
            }
          ]
        })
        for (let i = 0; i < allTokens.length; i += 1) {
          const lineThemedTokens = allTokens[i]
          for (const themedToken of lineThemedTokens) {
            tokens.push(Token.fromThemed(i, themedToken))
          }
        }
      }
    }
    return tokens
  }

  private static computeDiff(previous: Token[], current: Token[]): [Array<State>, Array<State>] {
    const anchMapP = HeckelDiff.anchors(previous)
    const anchMapC = HeckelDiff.anchors(current)
    // Symbol Tables
    const statesP: Array<State> = Array(previous.length).fill(Empty)
    const statesC: Array<State> = Array(current.length).fill(Empty)
    // Phase 1: Find unique anchors such that frequency = 1 in both lists.
    // That is a match.
    for (let i = 0; i < current.length; i += 1) {
      const token = current[i]
      if (anchMapP.has(token.key()) && anchMapC.has(token.key())) {
        const anchP = anchMapP.get(token.key())!
        const anchC = anchMapC.get(token.key())!
        const match: Match = {
          kind: 'match',
          previousIdx: anchP.index,
          previous: previous[anchP.index],
          currentIdx: anchC.index,
          current: current[anchC.index]
        }
        // Propagate morph id
        current[anchC.index].setMorphId(previous[anchP.index].morphId())
        statesP[anchP.index] = match
        statesC[anchC.index] = match
      }
    }
    // Phase 2: We found unique anchors.
    // Move forward and find the ones that are matching adjacent to the ones that already matched.
    for (let i = 0; i < statesC.length - 1; i += 1) {
      const state = statesC[i]
      const nextState = statesC[i + 1]
      if (state.kind === 'match' && nextState.kind === 'empty') {
        const matchState = state as Match
        const nextToken: Token | undefined = current[i + 1]
        const nextPreviousToken: Token | undefined = previous[matchState.previousIdx + 1]
        if (nextToken && nextPreviousToken && nextToken.key() == nextPreviousToken.key()) {
          const match: Match = {
            kind: 'match',
            previousIdx: matchState.previousIdx + 1,
            previous: nextPreviousToken,
            current: nextToken,
            currentIdx: i + 1
          }
          // Propagate morph id
          nextToken.setMorphId(nextPreviousToken.morphId())
          statesP[match.previousIdx] = match
          statesC[match.currentIdx] = match
        }
      }
    }
    // Phase 3: Same as Phase 2 but backwards.
    for (let i = statesC.length - 1; i >= 1; i -= 1) {
      const state = statesC[i]
      const priorState = statesC[i - 1]
      if (state.kind === 'match' && priorState.kind === 'empty') {
        const matchState = state as Match
        const priorToken = current[i - 1]
        const priorPreviousToken = previous[matchState.previousIdx - 1]
        if (priorToken && priorPreviousToken && priorToken.key() == priorPreviousToken.key()) {
          const match: Match = {
            kind: 'match',
            previousIdx: matchState.previousIdx - 1,
            previous: priorPreviousToken,
            current: priorToken,
            currentIdx: i - 1
          }
          // Propagate morph id
          priorToken.setMorphId(priorPreviousToken.morphId())
          statesP[match.previousIdx] = match
          statesC[match.currentIdx] = match
        }
      }
    }
    // Phase 4: Final pass.
    // Anything that did not match in:
    // - statesP = Delete
    // - statesC = Insert
    for (let i = 0; i < statesP.length; i += 1) {
      if (statesP[i].kind === 'empty') {
        const del: Delete = {
          kind: 'delete',
          index: i,
          token: previous[i]
        }
        statesP[i] = del
      }
    }
    for (let i = 0; i < statesC.length; i += 1) {
      if (statesC[i].kind === 'empty') {
        const insert: Insert = {
          kind: 'insert',
          index: i,
          token: current[i]
        }
        // For inserts generate a new morph id
        current[i].setMorphId(HeckelDiff.generateMorphId())
        statesC[i] = insert
      }
    }
    return [statesP, statesC]
  }

  private static anchors(tokens: Token[]): Map<string, { frequency: number, index: number }> {
    const map = new Map<string, { frequency: number, index: number }>()
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      const key = token.key()
      const count = map.get(key) ?? 0
      if (count == 0) {
        map.set(key, { frequency: count + 1, index: i })
      } else {
        map.delete(key)
      }
    }
    return map
  }

  private static zip(parsed: Array<Token[]>): Array<number[]> {
    const pairs: Array<number[]> = []
    let index = 0
    let previousIdx = HeckelDiff.zipIndex(index, parsed)
    if (!previousIdx) return pairs
    let i = previousIdx + 1
    while (i < parsed.length) {
      let currentIdx = HeckelDiff.zipIndex(i, parsed)
      if (!currentIdx) break
      else {
        pairs.push([previousIdx, currentIdx])
        previousIdx = currentIdx
        i = currentIdx + 1
      }
    }
    return pairs
  }

  private static zipIndex(start: number, parsed: Array<Token[]>): number | undefined {
    for (let i = start; i < parsed.length; i += 1) {
      const lineTokens = parsed[i]
      if (lineTokens && lineTokens.length > 0) return i
    }
    return undefined
  }

  private static tokensAsState(tokens: Token[]): State[] {
    const inserts: State[] = []
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      const insert: Insert = {
        kind: 'insert',
        index: i,
        token: token
      }
      inserts.push(insert)
    }
    return inserts
  }
}
