// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED TOGGLE (on/off switch) primitive — tier 3, BUILT AHEAD OF A
// CONSUMER on the maintainer's call. NOT a consolidation: the four-way read
// found the three "toggle"-named classes are three unrelated things — slides'
// `input.ed-toggle` is a native checkbox, spaces' `.sp-toggle-body` is the
// collapsible body of a disclosure block, type's `.t-toggles` is a segmented
// button group — and no app has a shared on/off switch. So this is a new,
// minimal switch; revisit if no app adopts it. See docs/DECISIONS.md.
//
// Kept to what a switch is, and to the one thing that makes it not
// mouse-only: it is a real <button role="switch"> with `aria-checked`, so the
// platform gives it keyboard operation (Space/Enter activate a button) and a
// screen reader announces it as a switch and its state. Values are the host
// app's through `--bks-*` chains (toggle.css); never light-dark().

export interface ToggleOpts {
  /** Visible label beside the switch, and its accessible name. */
  label: string
  /** Initial state (default off). */
  checked?: boolean
  /** Fired with the new state on every user toggle (not on `set`). */
  onChange?: (checked: boolean) => void
}

export interface Toggle {
  /** The label row: the switch button plus its text. Put it in a panel. */
  readonly root: HTMLElement
  /** The switch button itself (`role="switch"`). */
  readonly control: HTMLElement
  readonly checked: boolean
  /** Set the state programmatically. Updates aria + the visual; does NOT fire
   *  onChange — a set is the app's own doing, not the user's. */
  set(checked: boolean): void
  destroy(): void
}

export function createToggle(opts: ToggleOpts): Toggle {
  let checked = !!opts.checked

  const root = document.createElement('label')
  root.className = 'bks'

  const control = document.createElement('button')
  control.type = 'button'
  control.className = 'bks-switch'
  control.setAttribute('role', 'switch')
  control.setAttribute('aria-checked', String(checked))
  control.setAttribute('aria-label', opts.label)

  const text = document.createElement('span')
  text.className = 'bks-label'
  text.textContent = opts.label

  root.append(control, text)

  const render = (): void => {
    control.setAttribute('aria-checked', String(checked))
    root.classList.toggle('bks-on', checked)
  }

  // A <button> activates on click AND on Space/Enter natively, so there is one
  // handler and the keyboard comes free — no second keydown path to double-fire.
  const onClick = (ev: Event): void => {
    ev.preventDefault()
    checked = !checked
    render()
    opts.onChange?.(checked)
  }
  control.addEventListener('click', onClick)
  render()

  return {
    root,
    control,
    get checked() { return checked },
    set(v: boolean): void { checked = !!v; render() },
    destroy(): void { control.removeEventListener('click', onClick); root.remove() },
  }
}
