// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

// Tokens come from the kernel tokenizer — the zero-cost tier. The format still
// carries the grammar/theme asset seam (CodeElement.grammarAssetId/themeAssetId)
// for a future signed-extension tier with real TextMate grammars; the diff
// below never cared where tokens come from, which is what makes both tiers
// share one engine.
// import type, deliberately: only type names are used, and the erased import
// is what lets scripts/test-codediff.ts run this file under plain node
// (extensionless runtime imports do not resolve there).
import type { BentoDoc, Slide } from "./model"
import { tokenize, type Tok } from "../../kernel/src/tokenize.ts"

// The stable token that we can diff between slides.

export class Token {

  /* The morph id. */
  _id: string | undefined
  // Explicit fields, not constructor parameter properties: the repo's test
  // rigs run TypeScript sources under plain node, whose type stripping cannot
  // execute parameter properties (scripts/test-codediff.ts imports this file).
  readonly content: string
  readonly scopes: Array<string>
  readonly lineNumber: number
  readonly offset: number

  constructor(content: string, scopes: Array<string>, lineNumber: number, offset: number) {
    this.content = content
    this.scopes = scopes
    this.lineNumber = lineNumber
    this.offset = offset
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
    // Calls and plain identifiers share an identity bucket. The tokenizer
    // classes a word by its role — `render(` is a call, `.then(render)` a
    // plain reference — so the SAME word flips class exactly when a refactor
    // changes style (callback -> point-free -> await). Keying on the class
    // made such a word die and respawn instead of travelling; the audience
    // pairs tokens by their glyphs, not their colour, so identity does too.
    // Rendering still uses the true class — a paired token recolours at rest.
    const buckets = this.scopes.map((sc) => (sc === 'f' ? 'x' : sc))
    const json = {
      content: this.content,
      scopes: buckets,
      depth: this.depth()
    }
    return JSON.stringify(json)
  }

  /**
   * Adapt one kernel token, splitting multiline tokens at newlines FIRST.
   *
   * The tokenizer's contract allows block comments, triple-quoted strings and
   * whitespace runs to carry newlines. Rendered tokens with ink must become
   * atomic inline-level boxes to be animatable (a transform does nothing to a
   * non-replaced inline element), and a newline inside an atomic box stops
   * breaking the line under `white-space: pre` — a Python docstring would
   * collapse its whole block to one rendered line. Splitting HERE, before
   * identity assignment, keeps one diff token per rendered span; splitting in
   * the renderer instead would put one morph id on several spans and corrupt
   * the offset map. Concatenating the split pieces reproduces the original
   * token exactly, so the tokenizer's lossless guarantee survives.
   */
  static fromTok(tok: Tok, lineNumber: number, offset: number): Token[] {
    const out: Token[] = []
    let line = lineNumber
    let off = offset
    for (const piece of tok.v.split(/(\n)/)) {
      if (!piece) continue
      out.push(new Token(piece, [tok.t], line, off))
      if (piece === '\n') { line += 1; off = 0 } else off += piece.length
    }
    return out
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

  private readonly doc: BentoDoc

  constructor(doc: BentoDoc) {
    this.doc = doc
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
    // !== undefined, not truthiness: slide index 0 is falsy, and a morph group
    // whose first code slide is the deck's first slide got no ids at all.
    if (firstIdx !== undefined) {
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

  private static parse(_doc: BentoDoc, slide: Slide, mid: string|undefined): Token[] {
    const tokens: Token[] = []
    for (const el of slide.elements) {
      // The effective morph key is morphId || id, matching render.ts — a lone
      // code element with no explicit morphId still diffs against its
      // duplicate-a-slide twins (the duplicate idiom shares ids).
      if (el.type === 'code' && (el.morphId ?? el.id) === mid) {
        let line = 0
        let off = 0
        for (const tok of tokenize(el.content ?? '', el.grammarName ?? 'js')) {
          const split = Token.fromTok(tok, line, off)
          tokens.push(...split)
          const last = split[split.length - 1]
          if (last) {
            if (last.content === '\n') { line = last.lineNumber + 1; off = 0 }
            else { line = last.lineNumber; off = last.offset + last.content.length }
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
    // Phases 2 & 3 — spread from every anchor, breadth-first. One ring per
    // round: each match may claim ONE neighbour per direction per round, so a
    // token is claimed by its NEAREST anchor, not by whichever cascade happens
    // to run first. The previous greedy sweeps lost the shared-prefix swap:
    //
    //   const a = one()          const b = two()
    //   const b = two()    ->    const a = one()
    //
    // The header cascade (function f() { ...) walked forward straight into the
    // first `const` and paired it top-to-top, three steps from its anchor —
    // while `b`, only two steps away, was still waiting for the backward
    // sweep. Its own `const` then found the previous side already claimed and
    // was minted fresh: it vanished for 40% of the morph and faded back in,
    // on screen, in a deck. Distance-first, each `const` is claimed by the
    // anchor on its own line and travels with it. Claims never overwrite
    // (both sides must be unclaimed), so equal-distance conflicts — the
    // genuinely ambiguous ones — resolve deterministically to the earlier
    // token, and everything a cascade could reach is still reached.
    let frontier: number[] = []
    for (let i = 0; i < statesC.length; i += 1) {
      if (statesC[i].kind === 'match') frontier.push(i)
    }
    while (frontier.length > 0) {
      const next: number[] = []
      for (const ci of frontier) {
        const m = statesC[ci] as Match
        for (const step of [1, -1]) {
          const nc = ci + step
          const np = m.previousIdx + step
          if (nc < 0 || nc >= statesC.length || statesC[nc].kind !== 'empty') continue
          if (np < 0 || np >= previous.length || statesP[np].kind !== 'empty') continue
          if (current[nc].key() !== previous[np].key()) continue
          const match: Match = {
            kind: 'match',
            previousIdx: np,
            previous: previous[np],
            currentIdx: nc,
            current: current[nc]
          }
          // Propagate morph id
          current[nc].setMorphId(previous[np].morphId())
          statesP[np] = match
          statesC[nc] = match
          next.push(nc)
        }
      }
      frontier = next
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

  /**
   * Keys occurring EXACTLY once, with their index. Counted over the full list:
   * the previous add-then-delete dance re-added a key on its third occurrence,
   * so any token repeating an odd number of times — a third `)` is enough —
   * became a false "unique" anchor and Phase 1 paired wrong positions.
   * Regression: scripts/test-codediff.ts.
   */
  private static anchors(tokens: Token[]): Map<string, { frequency: number, index: number }> {
    const freq = new Map<string, { frequency: number, index: number }>()
    for (let i = 0; i < tokens.length; i += 1) {
      const key = tokens[i].key()
      const e = freq.get(key)
      if (e) e.frequency += 1
      else freq.set(key, { frequency: 1, index: i })
    }
    for (const [key, e] of freq) if (e.frequency !== 1) freq.delete(key)
    return freq
  }

  private static zip(parsed: Array<Token[]>): Array<number[]> {
    const pairs: Array<number[]> = []
    let index = 0
    let previousIdx = HeckelDiff.zipIndex(index, parsed)
    if (previousIdx === undefined) return pairs
    let i = previousIdx + 1
    while (i < parsed.length) {
      let currentIdx = HeckelDiff.zipIndex(i, parsed)
      if (currentIdx === undefined) break
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
