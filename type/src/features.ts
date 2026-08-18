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
  /** tab label beside Outline / Review / Signatures */
  label: Label;
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
export const panels = (): PanelSpec[] => byOrder(PANELS);
export const keys = (): KeySpec[] => KEYS;

/** Does this event match a registered shortcut? Returns the first match. */
export function matchKey(e: KeyboardEvent): KeySpec | undefined {
  const mod = e.metaKey || e.ctrlKey;
  return KEYS.find(k =>
    k.key === e.key.toLowerCase() &&
    !!k.mod === mod && !!k.shift === e.shiftKey && !!k.alt === e.altKey);
}
