// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The export-as-images dialog: DOM and accessibility, and nothing else.
//
// Verified by the UI section of scripts/test-slide-image-export-browser.ts.
//
// WHAT THIS MODULE IS NOT. It does not read the store, render a slide, build an
// archive, or download anything. It collects three choices, hands them to a
// callback, and reflects whatever that callback reports back. That boundary is
// why the whole state machine can be exercised in a browser with a stub for the
// work — and why an export bug can never be a dialog bug.
//
// The state machine is small and worth naming, because every subtle requirement
// hangs off it:
//
//   idle       → the user is choosing. Escape and Cancel just close.
//   running    → choices are disabled, progress is announced, and Cancel means
//                ABORT rather than close.
//   cancelling → the abort has been signalled and the work is winding down. The
//                dialog stays up: closing here would tell the user it stopped
//                before it actually had.
//   closed     → gone from the DOM, focus handed back.
//
// An error does NOT close it. The message is the only thing the user has, and a
// dialog that vanishes takes it with it.

import { t } from '../i18n'
import type { ExportProgress, SlideImageExportOptions } from '../image-export'

export interface ImageExportDialogController {
  setProgress(progress: ExportProgress): void
  showError(message: string): void
  close(): void
}

export interface ImageExportDialogContext {
  /** How many slides "all" would export — shown so the choice is informed. */
  mainSlideCount: number
  /** An unlocked password-protected deck: the image will not be encrypted. */
  encrypted: boolean
  /**
   * Where focus goes when this closes.
   *
   * Passed EXPLICITLY rather than read from `document.activeElement`, because
   * by the time this opens the menu item that was clicked has already closed
   * its menu and lost focus — capturing it here would capture `<body>`, and the
   * keyboard user would be dropped at the top of the document.
   */
  returnFocusTo?: HTMLElement | null
}

type DialogState = 'idle' | 'running' | 'cancelling' | 'closed'

/**
 * Open the dialog. `run` is called once, when the user confirms.
 *
 * Deliberately returns nothing: the caller's work lives in `run`, and giving
 * this a promise would invite callers to sequence UI against it.
 */
export function promptSlideImageExport(
  context: ImageExportDialogContext,
  run: (
    options: SlideImageExportOptions,
    controller: ImageExportDialogController,
    signal: AbortSignal,
  ) => Promise<void>,
): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'ed-dialog ed-image-export'

  // Every string is resolved HERE, at open time, never at module scope: a
  // module-level t() freezes the English at import and never sees the viewer's
  // locale (CLAUDE.md, i18n gotchas).
  const headingId = `ed-image-export-title-${Math.random().toString(36).slice(2, 9)}`
  dialog.setAttribute('aria-labelledby', headingId)

  const heading = document.createElement('h2')
  heading.id = headingId
  // The heading has no ellipsis: the menu item promises a dialog, the dialog IS
  // the dialog. Same wording otherwise, so the two read as one action.
  heading.textContent = t('Export slides as images')
  dialog.appendChild(heading)

  const options = document.createElement('div')
  options.className = 'ed-image-export-options'
  dialog.appendChild(options)

  /** One labelled group of radios. Radios, not a select: three short choices
   *  read faster as three visible options than as a closed list. */
  const group = (
    name: string,
    legend: string,
    choices: Array<{ value: string; label: string; checked?: boolean }>,
  ) => {
    const fieldset = document.createElement('fieldset')
    fieldset.className = 'ed-image-export-group'
    const caption = document.createElement('legend')
    caption.textContent = legend
    fieldset.appendChild(caption)
    for (const choice of choices) {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = name
      input.value = choice.value
      if (choice.checked) input.checked = true
      label.appendChild(input)
      label.appendChild(Object.assign(document.createElement('span'), { textContent: choice.label }))
      fieldset.appendChild(label)
    }
    options.appendChild(fieldset)
    return fieldset
  }

  // DEFAULTS: the current slide, PNG, 1x. The common case is "I want this one
  // slide to put somewhere", and 1x PNG is the answer that surprises nobody.
  group('scope', t('Slides to export'), [
    { value: 'current', label: t('Current slide'), checked: true },
    {
      value: 'all-main',
      label: t('All main slides ({n})', { n: String(context.mainSlideCount) }),
    },
  ])
  group('format', t('Image format'), [
    { value: 'png', label: t('PNG'), checked: true },
    { value: 'jpeg', label: t('JPEG') },
  ])
  group('scale', t('Image size'), [
    { value: '1', label: t('1× — original size'), checked: true },
    { value: '2', label: t('2× — double size') },
  ])

  if (context.encrypted) {
    const note = document.createElement('p')
    note.className = 'ed-image-export-note'
    note.textContent = t(
      'Exported images and ZIP files are not password-protected. ' +
      'The original encrypted .bento.html file is not changed.')
    dialog.appendChild(note)
  }

  // One region for progress AND errors. Two would mean the user has to know
  // which one to look at; polite, so it never interrupts a screen reader
  // mid-sentence while slides tick past.
  const status = document.createElement('p')
  status.className = 'ed-image-export-status'
  status.setAttribute('aria-live', 'polite')
  dialog.appendChild(status)

  const actions = document.createElement('div')
  actions.className = 'ed-dialog-actions'
  const cancel = document.createElement('button')
  cancel.className = 'ed-image-export-cancel'
  cancel.textContent = t('Cancel')
  const confirm = document.createElement('button')
  confirm.className = 'ed-image-export-run ed-primary'
  confirm.textContent = t('Export')
  actions.appendChild(cancel)
  actions.appendChild(confirm)
  dialog.appendChild(actions)

  let state: DialogState = 'idle'
  let aborter: AbortController | null = null

  const inputs = () => Array.from(dialog.querySelectorAll<HTMLInputElement>('input'))
  const chosen = (name: string): string =>
    dialog.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? ''

  const setBusy = (busy: boolean) => {
    for (const input of inputs()) input.disabled = busy
    confirm.disabled = busy
  }

  const finish = () => {
    if (state === 'closed') return
    state = 'closed'
    if (dialog.open) dialog.close()
    dialog.remove()
    // Explicit, and after removal: the browser restores focus to whatever had
    // it when a dialog opened, which here was nothing useful.
    const back = context.returnFocusTo
    if (back && back.isConnected) back.focus()
  }

  const controller: ImageExportDialogController = {
    setProgress(progress) {
      if (state !== 'running') return
      status.classList.remove('is-error')
      status.textContent = t('Rendering slide {n} of {total}…', {
        n: String(progress.completed),
        total: String(progress.total),
      })
    },
    showError(message) {
      // An error ends the RUN, not the dialog. The choices come back so the
      // user can change one and try again without reopening anything.
      state = 'idle'
      aborter = null
      setBusy(false)
      // Cancel must be re-enabled: a cancellation race (user pressed Cancel,
      // abort fired, but the work threw an error rather than a cancellation)
      // leaves it disabled because onCancel disabled it and setBusy does not
      // touch it.
      cancel.disabled = false
      cancel.textContent = t('Cancel')
      status.classList.add('is-error')
      status.textContent = message
    },
    close: finish,
  }

  /** Cancel means two different things, and which one depends on the state. */
  const onCancel = () => {
    if (state === 'running') {
      // ABORT — exactly once, however many times it is asked for. The dialog
      // stays up until the work reports back: closing now would claim it had
      // stopped while it was still running.
      state = 'cancelling'
      status.classList.remove('is-error')
      status.textContent = t('Cancelling…')
      cancel.disabled = true
      aborter?.abort()
      aborter = null
      return
    }
    if (state === 'cancelling') return
    finish()
  }

  cancel.addEventListener('click', onCancel)
  // Escape fires `cancel` on a native dialog. Prevented while working, so the
  // browser cannot close a dialog that is still coordinating an abort.
  dialog.addEventListener('cancel', (event) => {
    if (state === 'running' || state === 'cancelling') event.preventDefault()
    onCancel()
  })

  confirm.addEventListener('click', () => {
    if (state !== 'idle') return
    state = 'running'
    aborter = new AbortController()
    setBusy(true)
    cancel.disabled = false
    status.classList.remove('is-error')
    status.textContent = t('Preparing download…')
    const signal = aborter.signal
    void Promise.resolve()
      .then(() => run({
        scope: chosen('scope') === 'all-main' ? 'all-main' : 'current',
        format: chosen('format') === 'jpeg' ? 'jpeg' : 'png',
        scale: chosen('scale') === '2' ? 2 : 1,
      }, controller, signal))
      .catch(() => {
        // The caller reports its own failures through showError, with a message
        // it can localize properly. This only catches a caller that threw
        // without saying anything, so the dialog cannot be left spinning.
        if (state === 'running' || state === 'cancelling') {
          controller.showError(t('Couldn’t export the slide images. Try again.'))
        }
      })
  })

  document.body.appendChild(dialog)
  dialog.showModal()
  // Focus the first choice rather than the primary button: the user came here
  // to choose, and landing on Export invites confirming defaults by reflex.
  inputs()[0]?.focus()
}
