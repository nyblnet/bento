// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE TOP BAR FITS ITSELF BY MEASURING — slides' algorithm, ported whole.
//
// Slides settled this first (#239, slides/src/editor/editor.ts fitTopbar) and
// spaces hand-copied it, then drifted: a 110px title floor against slides'
// 120, a fold that fired on a squeezed title rather than on real overflow, and
// no phone rule, so the two apps changed tier at different widths for the same
// reasons (measured, chrome-unification §3.2: slides compact ≤1360 / tight ≤880
// / fold ≤720; spaces ≤800 / ≤720 / ≤600). This is the one algorithm, written
// so that it has no spaces in it: class names, the title and the "is something
// open" test come in as options. It is meant to move to the kernel as
// kernel/src/ui/topbar.ts, at which point slides' copy is the second caller and
// this file becomes an import.
//
// The tiers, in order, each tried only while the previous one still does not fit:
//
//   compact  labels hide (icons + tooltips take over)
//   tight    the wordmark's word hides (the mark stays: it is the brand)
//   fold     low-use controls leave the bar for ⋯
//
// Below the fold's floor the bar SCROLLS. That lives in CSS (a phone media
// rule), because it is the one thing measuring cannot fix: fully folded the
// bar still needs its irreducible handful of 44px targets, and a 320px screen
// does not have them. Two consequences the stylesheet has to honour, both
// learned in slides (CLAUDE.md "Hard-won details" 9 and 10): a scroll container
// clips BOTH axes, so menus hanging off the bar go `position: fixed` against
// `--bar-bottom` published here; and a z-index on the bar is a CEILING for
// every menu inside it.

export interface TopbarFitOpts {
  /** the three tier classes, in the order they apply */
  tiers: readonly [compact: string, tight: string, fold: string]
  /** the one shrinkable item. Squeezed below `titleFloor` counts as cramped. */
  title?: () => HTMLElement | null
  /** slides' 120px: below it a title is too narrow to read */
  titleFloor?: number
  /**
   * At or below this viewport width the bar folds without measuring. It is the
   * phone, where 44px targets decide the layout, not whether labels fit.
   * Slides' constant, 700.
   */
  phoneWidth?: number
  /**
   * True while re-fitting would slam something shut under the reader — a menu
   * open off the bar, a dialog. Unfolding moves controls, and a menu whose
   * contents depend on the tier would change under them.
   */
  busy?: () => boolean
  /** called when the fold tier turns on or off (slides reparents here) */
  onFold?: (on: boolean) => void
  /** the custom property the bar's bottom edge is published under */
  bottomVar?: string
  /** the element that carries `bottomVar` (default: the bar's parent) */
  varHost?: HTMLElement
}

export interface TopbarFit {
  /** measure now */
  fit(): void
  /** stop observing (a rebuilt bar makes a new fit) */
  destroy(): void
}

export function createTopbarFit(bar: HTMLElement, o: TopbarFitOpts): TopbarFit {
  const [compact, tight, fold] = o.tiers
  const floor = o.titleFloor ?? 120
  const phone = o.phoneWidth ?? 700
  let folded: boolean | null = null
  const setFold = (on: boolean) => {
    if (folded === on) return
    folded = on
    o.onFold?.(on)
  }

  const fit = (): void => {
    if (!bar.isConnected) return
    // Phones fold unconditionally, as in slides.
    if (window.innerWidth <= phone) {
      bar.classList.add(compact, tight, fold)
      setFold(true)
      mo.takeRecords()
      return
    }
    if (o.busy?.()) return
    // scrollWidth counts content that sticks out of the padding box even with
    // overflow visible, so this IS the clipped-controls condition. 1px of slack
    // absorbs subpixel rounding at fractional zoom.
    const overflow = () => bar.scrollWidth - bar.clientWidth > 1
    // The title is the bar's only shrinkable item, so flexbox crushes it toward
    // its floor before anything overflows: full labels beside an unreadable
    // title. Labels and the word go while the title is squeezed, not only on
    // hard overflow. The FOLD waits for real overflow — moving whole controls
    // into a menu is a bigger step than dropping words, and slides takes it
    // only when nothing else will do.
    const t = o.title?.()
    const cramped = () => overflow() || (!!t && t.getBoundingClientRect().width < floor)
    bar.classList.remove(compact, tight, fold)
    setFold(false)
    if (cramped()) bar.classList.add(compact)
    if (cramped()) bar.classList.add(tight)
    if (overflow()) {
      bar.classList.add(fold)
      setFold(true)
    }
    // the class flips queued mutation records of their own; drop them, or the
    // observer re-runs this forever
    mo.takeRecords()
  }

  // A ResizeObserver on the bar is the primary width signal: it fires for every
  // viewport change, a phone rotating included, where matchMedia change events
  // do not fire under a driven viewport. The MutationObserver catches the
  // constant-width case — the people count appearing, a label changing
  // language. NOT 'class': the tier flips above are class changes on this very
  // element.
  const ro = new ResizeObserver(() => fit())
  ro.observe(bar)
  const mo = new MutationObserver(() => fit())
  mo.observe(bar, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'hidden'],
  })
  // Where the bar ends, for the menus that must go `fixed` once it scrolls. Its
  // height moves with the safe-area insets and with the 44px phone targets.
  const host = o.varHost ?? bar.parentElement ?? document.documentElement
  const publish = () => host.style.setProperty(o.bottomVar ?? '--bar-bottom', `${Math.round(bar.getBoundingClientRect().bottom)}px`)
  const bottomRO = new ResizeObserver(publish)
  bottomRO.observe(bar)
  const onResize = () => { fit(); publish() }
  window.addEventListener('resize', onResize)
  queueMicrotask(() => { fit(); publish() })

  return {
    fit,
    destroy() {
      ro.disconnect()
      mo.disconnect()
      bottomRO.disconnect()
      window.removeEventListener('resize', onResize)
    },
  }
}
