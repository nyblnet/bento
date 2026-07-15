// Present mode: a fullscreen Reveal.js overlay generated from the model.
// Slides marked transition:'morph' use GSAP Flip to animate elements whose
// ids match across the two slides (PowerPoint "Morph" behaviour).

import Reveal from 'reveal.js'
import RevealNotes from 'reveal.js/plugin/notes/notes'
import 'reveal.js/dist/reveal.css'
import { gsap } from 'gsap'
import { Flip } from 'gsap/Flip'
import type { BentoDoc, SlideElement } from './model'
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
    controls: true,
    progress: true,
    slideNumber: 'c/t',
    keyboardCondition: null,
    plugins: [RevealNotes],
  })

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
    if (!from || !to) return
    const fromIdx = [...slidesEl.children].indexOf(from)
    const toIdx = [...slidesEl.children].indexOf(to)
    const forward = toIdx > fromIdx
    // Morph forward into a morph slide, and un-morph when backing out of one.
    const morphing =
      (forward && doc.slides[toIdx]?.transition === 'morph') ||
      (!forward && doc.slides[fromIdx]?.transition === 'morph')
    if (morphing) runMorph(doc, from, to, fromIdx, toIdx)
  }) as any)

  deck.initialize().then(() => {
    if (startIndex > 0) deck.slide(startIndex, 0)
  })

  return { exit }
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
