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
