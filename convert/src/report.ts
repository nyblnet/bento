// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The fidelity report — the spine of the convert engine.
//
// Every conversion emits one. It is not logging: it is the product's honesty.
// Every converter in the world silently drops things; this one says what was
// carried, what was approximated, and what was dropped, each entry coded and
// pointing at where. Its first job is TRUST — a chart whose blank cells became
// zeros changes what the slide asserts, and must be reported whether or not
// anyone repairs it. Its second job is to be a work list for assisted repair,
// which only touches a named allowlist of judgement-shaped codes.
//
// Provenance is a hard requirement, not a nicety. ~91% of the colour in real
// decks resolves through a six-source cascade that fails SILENTLY — a
// backwards clrMap still renders, just dark-on-dark — so every resolved value
// records which level supplied it, and the report tallies the classes. A human
// then spot-checks "1,700 fills came from the theme" rather than each fill.

/** Which cascade level supplied a resolved value. */
export type Provenance = 'own' | 'layout' | 'master' | 'theme' | 'default'

export type Verdict = 'carried' | 'approximated' | 'dropped'

export interface FidelityEntry {
  /** stable kebab-case code, e.g. 'image-crop-dropped' */
  code: string
  verdict: Verdict
  /** where in the SOURCE, e.g. 'slide 4' or 'slide 4 / sp 12' */
  where: string
  /** one line a human can act on; written once per code, counted thereafter */
  detail: string
  /** occurrences folded into this entry (same code + where collapses) */
  count: number
}

export interface FidelityReport {
  entries: FidelityEntry[]
  counts: Record<Verdict, number>
  /** resolved-value provenance tallies, keyed `<kind>:<level>` e.g. 'fill:theme' */
  provenance: Record<string, number>
}

export class Report {
  private entries = new Map<string, FidelityEntry>()
  private prov = new Map<string, number>()

  /**
   * Record one finding. Same (code, where) folds into a count — a deck with
   * forty cropped images is one fact per slide, not forty alerts (an instinct
   * adopted from PR #88's exporter, which learned it the noisy way).
   */
  add(verdict: Verdict, code: string, where: string, detail: string): void {
    const key = `${code}${where}`
    const cur = this.entries.get(key)
    if (cur) cur.count++
    else this.entries.set(key, { code, verdict, where, detail, count: 1 })
  }

  /** Tally where a resolved value came from, e.g. trace('fill', 'theme'). */
  trace(kind: string, level: Provenance): void {
    const key = `${kind}:${level}`
    this.prov.set(key, (this.prov.get(key) ?? 0) + 1)
  }

  build(): FidelityReport {
    const entries = [...this.entries.values()]
    const counts: Record<Verdict, number> = { carried: 0, approximated: 0, dropped: 0 }
    for (const e of entries) counts[e.verdict] += e.count
    return { entries, counts, provenance: Object.fromEntries(this.prov) }
  }
}

/** One line for a person: a (verdict, code) with every place it happened. */
export interface FoldedEntry {
  verdict: Verdict
  code: string
  detail: string
  count: number
  /** "slides 3, 5–7", "the whole deck", or both joined; '' when unknown */
  where: string
}

/**
 * The report as a person reads it. The writers record each loss per slide, so
 * one kind of loss can appear on a dozen slides; this folds it to one line
 * per (verdict, code), dropped first, and keeps WHERE: "slides 3, 5–7".
 * Carried entries are left out (they are not losses). Shared by the CLI and
 * every page, so they cannot word it differently.
 */
export function foldReport(report: FidelityReport): FoldedEntry[] {
  const groups = new Map<string, { e: FidelityEntry; count: number; slides: Set<number>; other: Set<string> }>()
  for (const e of report.entries) {
    if (e.verdict === 'carried') continue
    const key = `${e.verdict}\u0000${e.code}`
    const g = groups.get(key) ?? { e, count: 0, slides: new Set<number>(), other: new Set<string>() }
    g.count += e.count
    const m = /^slide (\d+)\b/.exec(e.where)
    if (m) g.slides.add(Number(m[1]))
    else if (e.where) g.other.add(e.where === 'document' ? 'the whole deck' : e.where)
    groups.set(key, g)
  }
  const rank: Record<string, number> = { dropped: 0, approximated: 1 }
  return [...groups.values()]
    .map(({ e, count, slides, other }) => ({
      verdict: e.verdict, code: e.code, detail: e.detail, count,
      where: [slideRange([...slides]), ...other].filter(Boolean).join('; '),
    }))
    .sort((a, b) => (rank[a.verdict] ?? 2) - (rank[b.verdict] ?? 2))
}

/** [3, 5, 6, 7] → "slides 3, 5–7"; [4] → "slide 4"; [] → "". */
export function slideRange(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b)
  if (!s.length) return ''
  const runs: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    runs.push(j > i + 1 ? `${s[i]}–${s[j]}` : j === i + 1 ? `${s[i]}, ${s[j]}` : `${s[i]}`)
    i = j
  }
  return `${s.length === 1 ? 'slide' : 'slides'} ${runs.join(', ')}`
}
