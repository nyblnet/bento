// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED MODAL DIALOG primitive — tier 3, and the one of that tier's four
// that is a real consolidation. All four apps build their About dialog (and
// their smaller confirms) on a per-app overlay: slides `.ed-about-overlay`,
// spaces `.sp-overlay`, dash `.dx-about`, type `.t-overlay`, each with its own
// open/close in an about.ts. This is the substrate they share.
//
// WHERE "SLIDES IS THE BASIS" GIVES THE LEAST — and the brief said so up front.
// slides' dialog machinery is one class (`.ed-dialog-actions`); it blurs the
// active element and removes an overlay. The fuller behaviour is in spaces' and
// type's about.ts, and this primitive takes it from there:
//
//   spaces  captures document.activeElement on open and RESTORES it on close,
//           and closes on a CAPTURE-PHASE, document-level Escape (its own
//           comment: "a dialog whose Escape must win over the editor's").
//   type    a named keydown handler removed on close, stopPropagation on Escape.
//   dash    an actions() row builder — the [Cancel] [Confirm] pattern.
//   slides  blur-the-opener, so a keystroke does not fall through to the canvas.
//
// What NO app had, and the primitive adds because a modal without it is a modal
// only for the mouse: a real focus TRAP (Tab cycles within the card), backdrop
// dismissal, `role="dialog"` + `aria-modal` + `aria-labelledby`, and — detail 9
// and 10 — a `position: fixed` scrim at a z above the topbar's ceiling so the
// dialog escapes every ancestor stacking context and clip.
//
// Values are the host app's, through `--bkd-*` fallback chains onto whatever the
// app already defines (dialog.css); never light-dark(); the shared theming
// guard (scripts/lib/ui-theme-guard.ts) checks it. Kernel half only.

export interface DialogOpts {
  /** Accessible title. Rendered as the card's heading and wired to
   *  `aria-labelledby`; omit to supply your own labelled content and pass
   *  `label` instead. */
  title?: string
  /** aria-label when there is no visible title. */
  label?: string
  /** The dialog body — the app's content. */
  content: HTMLElement
  /** Optional actions row (buttons). Rendered pinned at the card's foot. */
  actions?: HTMLElement[]
  /** Called after the dialog closes, however it closed. */
  onClose?: () => void
  /** Backdrop click closes (default true). A confirint dialog may want false so
   *  a stray click cannot dismiss an unanswered question. */
  dismissOnBackdrop?: boolean
}

export interface Dialog {
  /** The full-viewport overlay (scrim). Appended to the body on open. */
  readonly root: HTMLElement
  /** The dialog card. */
  readonly card: HTMLElement
  readonly isOpen: boolean
  open(): void
  close(): void
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

let seq = 0

export function createDialog(opts: DialogOpts): Dialog {
  const id = `bkd-title-${++seq}`
  const root = document.createElement('div')
  root.className = 'bkd-overlay'

  const card = document.createElement('div')
  card.className = 'bkd-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.tabIndex = -1
  if (opts.title) card.setAttribute('aria-labelledby', id)
  else if (opts.label) card.setAttribute('aria-label', opts.label)

  if (opts.title) {
    const h = document.createElement('h2')
    h.className = 'bkd-title'
    h.id = id
    h.textContent = opts.title
    card.appendChild(h)
  }
  opts.content.classList.add('bkd-body')
  card.appendChild(opts.content)
  if (opts.actions?.length) {
    const bar = document.createElement('div')
    bar.className = 'bkd-actions'
    for (const b of opts.actions) bar.appendChild(b)
    card.appendChild(bar)
  }
  root.appendChild(card)

  let open = false
  let returnFocus: HTMLElement | null = null

  const focusables = (): HTMLElement[] =>
    [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === card)

  // Capture-phase, on the document, so the dialog's Escape wins over an editor
  // that also listens for it (spaces' hard-won rule), and so Tab can be trapped
  // before anything else acts on it.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); api.close(); return }
    if (e.key !== 'Tab') return
    // The focus TRAP no app had: Tab off either end of the card wraps to the
    // other end, so focus can never leave an open modal.
    const f = focusables()
    if (!f.length) { e.preventDefault(); card.focus(); return }
    const first = f[0], last = f[f.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || active === card)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
  }

  const onBackdrop = (e: MouseEvent): void => {
    if (e.target === root && (opts.dismissOnBackdrop ?? true)) api.close()
  }

  const api: Dialog = {
    root,
    card,
    get isOpen() { return open },
    open(): void {
      if (open) return
      open = true
      returnFocus = document.activeElement as HTMLElement | null
      document.body.appendChild(root)
      document.addEventListener('keydown', onKey, true)
      root.addEventListener('mousedown', onBackdrop)
      // Move focus into the card: the first focusable, else the card itself, so
      // the very next keystroke is the dialog's, not the surface behind it.
      ;(focusables()[0] ?? card).focus()
    },
    close(): void {
      if (!open) return
      open = false
      document.removeEventListener('keydown', onKey, true)
      root.removeEventListener('mousedown', onBackdrop)
      root.remove()
      // Restore focus to whatever opened the dialog — a keyboard user is put
      // back where they were, not dropped on document.body.
      try { returnFocus?.focus() } catch { /* opener is gone */ }
      returnFocus = null
      opts.onClose?.()
    },
  }
  return api
}
