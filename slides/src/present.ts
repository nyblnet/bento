// Present mode: a fullscreen Reveal.js overlay generated from the model.
// Slides marked transition:'morph' use GSAP Flip to animate elements whose
// ids match across the two slides (PowerPoint "Morph" behaviour).

import Reveal from 'reveal.js'
import RevealNotes from 'reveal.js/plugin/notes/notes'
import 'reveal.js/dist/reveal.css'
import { gsap } from 'gsap'
import { Flip } from 'gsap/Flip'
import type { BentoDoc, Slide, SlideElement } from './model'
import { renderSlide } from './render'

gsap.registerPlugin(Flip)

const MORPH_DURATION = 0.65
const MORPH_EASE = 'power2.inOut'

export interface PresentSession {
  exit(): void
}

export function startPresentation(
  doc: BentoDoc,
  startIndex: number,
  onExit: (lastIndex: number) => void,
): PresentSession {
  const overlay = document.createElement('div')
  overlay.className = 'bento-present-overlay'

  const revealEl = document.createElement('div')
  revealEl.className = 'reveal'
  const slidesEl = document.createElement('div')
  slidesEl.className = 'slides'
  revealEl.appendChild(slidesEl)
  overlay.appendChild(revealEl)

  doc.slides.forEach((slide) => {
    const section = document.createElement('section')
    // Morph slides swap instantly; the Flip animation supplies the motion.
    section.dataset.transition = slide.transition === 'morph' ? 'none' : slide.transition
    section.appendChild(renderSlide(slide, doc))
    if (slide.notes) {
      const aside = document.createElement('aside')
      aside.className = 'notes'
      aside.textContent = slide.notes
      section.appendChild(aside)
    }
    slidesEl.appendChild(section)
  })

  document.body.appendChild(overlay)

  let exited = false
  const deck = new Reveal(revealEl, {
    embedded: true,
    width: doc.size.width,
    height: doc.size.height,
    margin: 0,
    center: false,
    hash: false,
    history: false,
    transition: 'fade',
    transitionSpeed: 'default',
    backgroundTransition: 'fade',
    controls: doc.present?.controls ?? true,
    progress: doc.present?.progress ?? true,
    slideNumber: (doc.present?.slideNumber ?? true) ? 'c/t' : false,
    keyboardCondition: null,
    plugins: [RevealNotes],
  })

  const onResize = () => deck.layout()

  const exit = () => {
    if (exited) return
    exited = true
    const last = deck.getIndices().h
    try {
      deck.destroy()
    } catch {
      /* Reveal teardown is best-effort */
    }
    overlay.remove()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeydown, true)
    onExit(last)
  }

  // Esc exits the show (capture phase so Reveal's own Esc handling never sees it).
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      if (deck.isOverview()) return // let Reveal close its overview first
      ev.preventDefault()
      ev.stopPropagation()
      exit()
    }
  }
  document.addEventListener('keydown', onKeydown, true)

  deck.on('slidechanged', ((event: any) => {
    const from = event.previousSlide as HTMLElement | undefined
    const to = event.currentSlide as HTMLElement
    if (!to) return
    const fromIdx = from ? [...slidesEl.children].indexOf(from) : -1
    const toIdx = [...slidesEl.children].indexOf(to)
    if (from) gsap.killTweensOf(from.querySelectorAll('.bento-el'))
    const forward = toIdx > fromIdx
    // Morph forward into a morph slide, and un-morph when backing out of one.
    const morphing =
      from &&
      ((forward && doc.slides[toIdx]?.transition === 'morph') ||
        (!forward && doc.slides[fromIdx]?.transition === 'morph'))
    if (morphing) runMorph(doc, from!, to, fromIdx, toIdx)
    else runEnterFx(doc.slides[toIdx], to)
    runAmbientFx(doc.slides[toIdx], to)
  }) as any)

  // Clicking an element with a link jumps to its target slide.
  slidesEl.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-link]')
    if (!target) return
    const idx = doc.slides.findIndex((s) => s.id === target.dataset.link)
    if (idx >= 0) {
      ev.preventDefault()
      ev.stopPropagation()
      deck.slide(idx, 0)
    }
  })

  deck.initialize().then(() => {
    if (startIndex > 0) deck.slide(startIndex, 0)
    // late layout: fonts/images that finish loading after init can change
    // the measured size, and the boot viewport may still be settling
    window.addEventListener('resize', onResize)
    setTimeout(onResize, 120)
    setTimeout(onResize, 600)
    const first = slidesEl.children[startIndex] as HTMLElement | undefined
    if (first) {
      runEnterFx(doc.slides[startIndex], first)
      runAmbientFx(doc.slides[startIndex], first)
    }
  })

  return { exit }
}

// --- element fx -------------------------------------------------------------

function fxNodes(slide: Slide, section: HTMLElement): Array<[SlideElement, HTMLElement]> {
  const pairs: Array<[SlideElement, HTMLElement]> = []
  for (const el of slide?.elements ?? []) {
    if (!el.fx) continue
    const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) pairs.push([el, node])
  }
  return pairs
}

/** Staggered entrance animations + count-ups for the incoming slide. */
function runEnterFx(slide: Slide, section: HTMLElement) {
  const entering = fxNodes(slide, section)
    .filter(([el]) => el.fx!.enter || el.fx!.countUp)
    .sort((a, b) => (a[0].fx!.order ?? 0) - (b[0].fx!.order ?? 0))
  entering.forEach(([el, node], i) => {
    const fx = el.fx!
    if (fx.enter) {
      gsap.fromTo(
        node,
        { opacity: 0, y: fx.enter === 'fade-up' ? 16 : 0 },
        {
          opacity: el.opacity,
          y: 0,
          duration: 0.55,
          delay: 0.12 + Math.min(i, 24) * 0.045,
          ease: 'power2.out',
          overwrite: 'auto',
        },
      )
    }
    if (fx.countUp) runCountUp(node)
  })
}

/** Animate every number in the element's text from 0 to its final value. */
function runCountUp(node: HTMLElement) {
  const inner = node.querySelector<HTMLElement>('.bento-text-inner') ?? node
  const final = inner.textContent ?? ''
  const tokens = [...final.matchAll(/\d+(?:[.,]\d+)?/g)]
  if (!tokens.length) return
  const state = { p: 0 }
  gsap.to(state, {
    p: 1,
    duration: 1.15,
    delay: 0.15,
    ease: 'power2.out',
    onUpdate() {
      let out = ''
      let last = 0
      for (const m of tokens) {
        out += final.slice(last, m.index)
        const raw = m[0].replace(',', '.')
        const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
        out += (parseFloat(raw) * state.p).toFixed(decimals)
        last = m.index! + m[0].length
      }
      inner.textContent = out + final.slice(last)
    },
  })
}

/** Continuous ambient motion (ken-burns style slow zoom on photos). */
function runAmbientFx(slide: Slide, section: HTMLElement) {
  for (const [el, node] of fxNodes(slide, section)) {
    if (el.fx!.ambient === 'kenburns') {
      gsap.fromTo(
        node,
        { scale: 1.02 },
        { scale: 1.1, duration: 26, ease: 'none', repeat: -1, yoyo: true, transformOrigin: '50% 40%' },
      )
    }
  }
}

// --- morph ------------------------------------------------------------------

function elementsById(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((n) => {
    map.set(n.dataset.flipId!, n)
  })
  return map
}

function modelById(doc: BentoDoc, index: number): Map<string, SlideElement> {
  const map = new Map<string, SlideElement>()
  for (const el of doc.slides[index]?.elements ?? []) map.set(el.id, el)
  return map
}

function runMorph(
  doc: BentoDoc,
  fromSection: HTMLElement,
  toSection: HTMLElement,
  fromIdx: number,
  toIdx: number,
) {
  const fromEls = elementsById(fromSection)
  const toEls = elementsById(toSection)
  const fromModel = modelById(doc, fromIdx)
  const toModel = modelById(doc, toIdx)

  const matchedFrom: HTMLElement[] = []
  const matchedTo: HTMLElement[] = []
  for (const [id, el] of fromEls) {
    const target = toEls.get(id)
    if (target) {
      matchedFrom.push(el)
      matchedTo.push(target)
    }
  }

  // Unmatched incoming elements simply fade/rise in.
  const entering = [...toEls.values()].filter((n) => !fromEls.has(n.dataset.flipId!))
  if (entering.length) {
    gsap.from(entering, {
      opacity: 0,
      y: 14,
      duration: 0.45,
      delay: MORPH_DURATION * 0.4,
      stagger: 0.03,
      ease: 'power2.out',
      clearProps: 'opacity,transform',
    })
  }
  if (!matchedFrom.length) return

  // Reveal has already hidden/transformed the outgoing section. Temporarily
  // neutralize that so Flip can measure where the elements really were.
  const saved = {
    display: fromSection.style.display,
    visibility: fromSection.style.visibility,
    transform: fromSection.style.transform,
    opacity: fromSection.style.opacity,
  }
  fromSection.style.display = 'block'
  fromSection.style.visibility = 'hidden'
  fromSection.style.transform = 'none'
  fromSection.style.opacity = '1'

  const state = Flip.getState(matchedFrom)

  fromSection.style.display = saved.display
  fromSection.style.visibility = saved.visibility
  fromSection.style.transform = saved.transform
  fromSection.style.opacity = saved.opacity

  // Geometry via Flip (position/size/rotation, scale mode like PowerPoint).
  Flip.from(state, {
    targets: matchedTo,
    duration: MORPH_DURATION,
    ease: MORPH_EASE,
    scale: true,
  })

  // Styles morph straight from the model — exact values, no DOM sniffing.
  for (const to of matchedTo) {
    const id = to.dataset.flipId!
    const a = fromModel.get(id)
    const b = toModel.get(id)
    if (!a || !b) continue
    if (a.opacity !== b.opacity) {
      gsap.fromTo(to, { opacity: a.opacity }, { opacity: b.opacity, duration: MORPH_DURATION, ease: MORPH_EASE })
    }
    if (a.type === 'shape' && b.type === 'shape' && a.fill !== b.fill) {
      const target = to.querySelector('rect,ellipse,polygon,line')
      if (target) {
        gsap.fromTo(
          target,
          { attr: { fill: a.fill } },
          { attr: { fill: b.fill }, duration: MORPH_DURATION, ease: MORPH_EASE },
        )
      }
    }
    if (a.type === 'text' && b.type === 'text' && a.color !== b.color) {
      const inner = to.querySelector<HTMLElement>('.bento-text-inner')
      if (inner) {
        gsap.fromTo(inner, { color: a.color }, { color: b.color, duration: MORPH_DURATION, ease: MORPH_EASE })
      }
    }
  }
}
