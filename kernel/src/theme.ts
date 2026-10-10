// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Theme selection, shared by every Bento app.
//
// A THEME IS A VIEWER PREFERENCE, NEVER DOCUMENT DATA. It lives in
// localStorage, exactly as the interface locale and reduced motion already do,
// and for the same reason: two people opening the same file are two different
// readers with two different eyes and two different rooms. A theme written into
// the document would travel to the recipient and override theirs — and worse,
// it would make the file's bytes depend on who last looked at it, which breaks
// the signature story in bento/type.
//
// THE DOCUMENT DOES NOT INVERT. Dark theme dims the CHROME. A slide's
// background is document data the author chose; a page is white because paper
// is white, and somebody proofing a contract at midnight still needs to see
// what will print. Apps express this by keeping surface tokens (--paper,
// --slide-*) out of the themed set.

export type ThemeChoice = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'bento-theme';

/**
 * localStorage access that cannot take the app down.
 *
 * Reading the `localStorage` PROPERTY — not calling a method on it — throws
 * when site data is blocked, inside some embedded webviews, and in any
 * sandboxed frame. bento/slides 1.0.15 shipped a fix for exactly this after one
 * unreadable preference cost users the whole document. A theme is worth less
 * than a document; it must degrade to the default in silence.
 */
function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function write(v: string): void {
  try { localStorage.setItem(KEY, v); } catch { /* preference simply is not remembered */ }
}

const media = (): MediaQueryList | null => {
  try { return matchMedia('(prefers-color-scheme: dark)'); } catch { return null; }
};

/** What the user asked for — 'auto' unless they chose otherwise. */
export function themeChoice(): ThemeChoice {
  const v = read();
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** What that resolves to right now, given the OS setting. */
export function resolvedTheme(choice: ThemeChoice = themeChoice()): ResolvedTheme {
  if (choice !== 'auto') return choice;
  return media()?.matches ? 'dark' : 'light';
}

type Listener = (t: ResolvedTheme) => void;
const listeners = new Set<Listener>();

/**
 * Put the theme on the document element.
 *
 * `data-theme` is what the stylesheets key off. `color-scheme` is what makes
 * the BROWSER's own furniture follow — scrollbars, form controls, the canvas
 * behind a rubber-band scroll. Without it a dark app keeps white scrollbars and
 * looks broken in exactly the places CSS cannot reach.
 */
export function applyTheme(choice: ThemeChoice = themeChoice()): ResolvedTheme {
  const t = resolvedTheme(choice);
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  for (const fn of listeners) fn(t);
  return t;
}

export function setTheme(choice: ThemeChoice): ResolvedTheme {
  write(choice);
  return applyTheme(choice);
}

/** Notified when the EFFECTIVE theme changes, including an OS flip on 'auto'. */
export function onThemeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let started = false;
/**
 * Apply the stored theme and keep following the OS while the choice is 'auto'.
 * Call once at boot, BEFORE the first paint if possible.
 */
export function startTheme(): ResolvedTheme {
  const t = applyTheme();
  if (!started) {
    started = true;
    media()?.addEventListener?.('change', () => {
      if (themeChoice() === 'auto') applyTheme('auto');
    });
  }
  return t;
}

/** The three choices, for a picker. Labels are the app's to translate. */
export const THEME_CHOICES: ThemeChoice[] = ['auto', 'light', 'dark'];
