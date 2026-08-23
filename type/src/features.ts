// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The feature registry — how a module adds itself to the chrome without
// editing the chrome.
//
// WHY. Every feature wants the same four things: a button in the bar, an item
// in the ⋯ menu, a panel beside the outline, and a keyboard shortcut. Wiring
// each one directly into main.ts made that file the place where all features
// meet, which is fine for two and miserable for ten — and impossible for
// several people working at once, because every feature's diff touches the same
// hundred lines.
//
// So a feature module registers what it wants and main.ts renders the registry.
// A feature is then ONE file plus one import line, which is also what makes it
// reviewable: everything belonging to find-and-replace is in find.ts.
//
// Registration happens at import time and the chrome is built after, so order
// is module evaluation order — deterministic, and the `order` field breaks ties
// where a group's arrangement matters.

import type { Editor } from './editor.ts';
import type { Store } from './store.ts';

/** What a feature is handed when it runs. Kept small on purpose. */
export interface FeatureContext {
  store: Store;
  editor: Editor;
  /** re-paginate and repaint; call after changing the document */
  refresh(): void;
  /**
   * Bring a registered panel to the front, opening the sidebar if it is shut.
   *
   * Without this a feature could register a panel and then have no way to show
   * it — the find feature reached through the DOM for the tab button and
   * cleared the sidebar's collapsed class by hand, which is a feature knowing
   * the chrome's markup.
   */
  showPanel(id: string): void;
  /** transient message to the reader */
  toast(msg: string): void;
}

/**
 * A label that may be resolved LATE.
 *
 * registerTool/registerPanel run at module scope, so a plain `t('Find')` in a
 * spec is evaluated at import time — frozen before the viewer's locale
 * resolves, which is the one i18n rule this codebase repeats everywhere. The
 * API was quietly forcing every feature to break it: one agent worked around it
 * with a getter, another noticed and said so. A thunk makes the correct thing
 * the easy thing, and a plain string still works for anything genuinely
 * constant.
 */
export type Label = string | (() => string);
export const text = (l: Label): string => (typeof l === 'function' ? l() : l);

export interface ToolSpec {
  id: string;
  /** inline SVG, from icons.ts — the house recipe, 24px box at 16px */
  icon: string;
  /** tooltip — pass `() => t('…')` so it resolves at render, not at import */
  title: Label;
  /** optional visible label beside the icon */
  label?: Label;
  /** which cluster of the bar it joins */
  group: 'format' | 'insert' | 'review' | 'right';
  order?: number;
  run(ctx: FeatureContext): void;
  /** highlight the button when this returns true (called on selection change) */
  active?(ctx: FeatureContext): boolean;
}

export interface MenuSpec {
  id: string;
  label: Label;
  icon?: string;
  order?: number;
  run(ctx: FeatureContext): void;
}

export interface PanelSpec {
  id: string;
  /** tab label */
  label: Label;
  /**
   * Which side it lives on, and this is not decoration.
   *
   * The suite's rule, written down in dash/src/panels.ts and copied from
   * slides: LEFT is navigation — the list of things in the document — and
   * RIGHT is the properties of whatever is selected. Two Bento apps that lay
   * themselves out differently read as two products.
   *
   * Getting it wrong is not merely untidy: paragraph layout first landed on
   * the left, beside Outline and Review, which put "properties of this
   * paragraph" in the column that answers "what is in this document".
   */
  side?: 'left' | 'right';
  /**
   * Mount into an EXISTING element instead of creating a tab of its own.
   *
   * Every left-hand feature registering its own tab is how the sidebar reached
   * eight of them — Outline, Review, Signatures, Comments, Figures, Sources,
   * Find, Math — which is more than fits, and more importantly is not eight
   * kinds of thing. They are three: where things are, what people did to the
   * document, and what it cites.
   *
   * So a panel can now say "I am a SECTION of the Review tab" rather than "I am
   * a tab". The tabs are declared once, in main.ts, by someone looking at the
   * whole sidebar; features fill them.
   */
  host?: string;
  order?: number;
  /** called once with the panel's host element */
  mount(host: HTMLElement, ctx: FeatureContext): void;
  /**
   * Called whenever the document changes.
   *
   * This was declared and never called — a panel implementing it was silently
   * dead, and the only reason nothing broke is that the first feature to want
   * it subscribed to the store itself instead. An interface that lies is worse
   * than one that is missing: the second is a compile error, the first is a
   * feature that quietly does nothing.
   */
  update?(host: HTMLElement, ctx: FeatureContext): void;
}

export interface KeySpec {
  /** lowercase key name, as KeyboardEvent.key reports it */
  key: string;
  mod?: boolean;      // ⌘ / Ctrl
  shift?: boolean;
  alt?: boolean;
  /**
   * The LITERAL Control key, as distinct from `mod`.
   *
   * `mod` deliberately conflates ⌘ and Ctrl, which is right for ⌘S/⌘B and
   * every other shortcut that means the same thing on both platforms. It is
   * wrong when a binding differs BY platform: Word moves a paragraph with
   * Alt+Shift+Arrow on Windows and Ctrl+Shift+Arrow on a Mac, because macOS
   * already uses Option+Shift+Arrow to extend a selection by paragraph. A
   * shortcut that has to be Control on one platform and Alt on the other
   * cannot be expressed with `mod`.
   */
  ctrl?: boolean;
  run(ctx: FeatureContext): void;
}

/**
 * Lifecycle hooks.
 *
 * `ready` fires once the app is built and a FeatureContext exists; `paginated`
 * fires after every pagination pass, which is the only moment a feature can
 * know a page number. Both exist because a feature that needs either had to
 * reach into main.ts for it otherwise.
 */
export type ReadyFn = (ctx: FeatureContext) => void;
export type PaginatedFn = (ctx: FeatureContext, metrics: unknown, host: HTMLElement) => void;
const READY: ReadyFn[] = [];
const PAGINATED: PaginatedFn[] = [];
export const registerReady = (f: ReadyFn): void => { READY.push(f); };

/**
 * The caret moved, or the selection changed.
 *
 * A CONTEXTUAL panel needs this and the document signal is not enough: moving
 * the caret from a paragraph into a table cell changes what the properties
 * panel should show without changing a byte of the document.
 */
export type SelectionFn = (ctx: FeatureContext) => void;
const SELECTION: SelectionFn[] = [];
export const registerSelection = (f: SelectionFn): void => { SELECTION.push(f); };
export const selectionFns = (): SelectionFn[] => SELECTION;
export const registerPaginated = (f: PaginatedFn): void => { PAGINATED.push(f); };
export const readyFns = (): ReadyFn[] => READY;
export const paginatedFns = (): PaginatedFn[] => PAGINATED;

const TOOLS: ToolSpec[] = [];
const MENU: MenuSpec[] = [];
const PANELS: PanelSpec[] = [];
const KEYS: KeySpec[] = [];

export const registerTool = (t: ToolSpec): void => { TOOLS.push(t); };
export const registerMenuItem = (m: MenuSpec): void => { MENU.push(m); };
export const registerPanel = (p: PanelSpec): void => { PANELS.push(p); };
export const registerKey = (k: KeySpec): void => { KEYS.push(k); };

const byOrder = <T extends { order?: number }>(a: T[]): T[] =>
  [...a].sort((x, y) => (x.order ?? 100) - (y.order ?? 100));

export const tools = (group: ToolSpec['group']): ToolSpec[] =>
  byOrder(TOOLS.filter(t => t.group === group));
export const menuItems = (): MenuSpec[] => byOrder(MENU);
export const panels = (side: 'left' | 'right' = 'left'): PanelSpec[] =>
  byOrder(PANELS.filter(p => (p.side ?? 'left') === side));
export const keys = (): KeySpec[] => KEYS;

/** Does this event match a registered shortcut? Returns the first match. */
export function matchKey(e: KeyboardEvent): KeySpec | undefined {
  const mod = e.metaKey || e.ctrlKey;
  return KEYS.find(k => {
    if (k.key !== e.key.toLowerCase()) return false;
    if (!!k.shift !== e.shiftKey || !!k.alt !== e.altKey) return false;
    // `ctrl` asks for Control SPECIFICALLY — and not Command, or a Mac user
    // pressing ⌘⇧↑ (select to the start of the document) would move a block.
    if (k.ctrl) return e.ctrlKey && !e.metaKey;
    return !!k.mod === mod;
  });
}
