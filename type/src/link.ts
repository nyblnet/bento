// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Links.
//
// NEEDS FROM THE CORE (two security holes and one ergonomic gap; I have not
// touched the files they live in):
//
//  1. **inline.ts `openTag` does not escape `"` in an href.** `esc()` handles
//     `& < >` only, so a mark with
//         href: 'https://x" onmouseover="alert(1)'
//     renders as
//         <a href="https://x" onmouseover="alert(1)">click me</a>
//     — a real event handler, because render.ts puts that string through
//     `innerHTML`. Verified in this tree, not reasoned about. This is arbitrary
//     script execution from opening a document, and the repo's rule is that
//     every document is untrusted input, so it is reachable without any user of
//     this feature being involved: a hand-written `#bento-doc` block, a pasted
//     `<a>` (fromDom copies the attribute verbatim), or a collaborator's op.
//     FIX: escape `"` in `ESC` — one entry, `'"': '&quot;'`. The round trip
//     survives it, because fromDom reads through `getAttribute`, which decodes.
//
//  2. **inline.ts `openTag` emits whatever scheme the mark carries.**
//     `toHtml('x', [{t:'link',from:0,to:1,href:'javascript:alert(1)'}])` yields
//     `<a href="javascript:alert(1)">`. Sanitising at the UI (which this file
//     does, twice) cannot close that, because the model is also written by
//     files, paste and sync. The rendering seam is the only place that sees
//     every href, so the allowlist belongs there too — `safeHref()` below is
//     written to be moved into inline.ts unchanged if you want it.
//
//  3. Not a bug, an ergonomic gap: `features.ts` has no `registerInit`, so a
//     feature that needs a listener on the editor cannot get a FeatureContext
//     until one of its own entry points fires. This file works around it by
//     remembering the ctx handed to `active()` (see `remember` — sound, because
//     `active()` runs on every selection change and the caret must be in the
//     document before anyone can type into it), but a one-line
//     `registerInit(fn)` called from main.ts beside `mountTools` would be
//     honest instead of clever, and every later feature will want it.
//
// WHAT IS NOT A BUG, because it was worth checking: `normalize()` groups by
// `` `${m.t} ${m.href ?? ''}` ``, so href IS part of the merge key and two
// adjacent DIFFERENT links do not fuse into one. That is the invariant this
// whole feature would otherwise silently violate every time someone linked two
// words in a row.
//
// THREE DECISIONS.
//
// A POPOVER, NOT `window.prompt`. prompt() blocks the event loop, cannot show
// the link you are standing on, cannot offer Remove or Open, and is unstyled —
// but the disqualifying one is that it destroys the selection in WebKit, and
// the selection is the range the link is about to be applied to. A popover also
// gets the caret's own coordinates: the target range is captured as MODEL
// positions before the input takes focus, so it survives losing the selection
// entirely, which is the same reason the caret is a model position at all.
//
// AUTOLINK IS DELIBERATELY NARROW: an explicit `http(s)://` URL, the `www.`
// idiom, or an email address. It does NOT fire on a bare `example.com`, and
// that restraint is the point. This app is aimed at prose — contracts, reports
// — where a bare-domain rule mangles `index.html`, `README.md` (`.md` is a real
// TLD), `Schedule A.doc` and `Mr.Smith` on the way past, and the cost is paid
// on every keystroke of ordinary writing while the escape hatch is one ⌘K.
// Word autolinks bare domains and it is a famous annoyance, not a feature.
//
// COST, since this runs on every input event: the first test is
// `text[caret-1] === ' '`. Ordinary typing fails it and returns in constant
// time; only a space arms the backward scan, which is bounded to one token.

import { registerTool, registerKey, type FeatureContext } from './features.ts';
import { addMark, removeMark, type Mark } from './inline.ts';
import { isNoteAtom } from './render.ts';
import { ICONS } from './icons.ts';
import { t } from './i18n.ts';

// ───────────────────────────────────────────────────────── URL sanitising
//
// AN ALLOWLIST, NOT A DENYLIST. A denylist that knows about `javascript:` and
// `data:` misses `vbscript:`, `blob:`, `filesystem:`, `jar:` and whatever ships
// next; an allowlist is wrong only in the direction of refusing something
// harmless, which is the direction a security boundary should fail in.

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ALLOWED = new Set(['http', 'https', 'mailto', 'tel']);
const EMAILISH = /^[^\s@]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,24}$/;

/**
 * What an author typed, turned into an href that is safe to store and to
 * render — or `null` if there is no honest reading of it.
 *
 * Controls, spaces and DEL are stripped from ANYWHERE in the string, not just
 * trimmed off the ends. That is not tidiness: browsers strip tab, LF and CR
 * from a URL before parsing it, so `java\tscript:alert(1)` is a live
 * `javascript:` URL that a naive `startsWith` check reads as a relative path.
 * Stripping first means the scheme test sees what the browser will see. Real
 * URLs cannot contain a raw space in any case — that is what %20 is for.
 */
export function sanitizeUrl(raw: string): string | null {
  const s = (raw ?? '').replace(/[\u0000-\u0020\u007f]/g, '');
  if (!s) return null;
  const m = SCHEME.exec(s);
  if (m) return ALLOWED.has(m[1].toLowerCase()) ? quote(s) : null;
  // In-document fragment: no scheme, no host, nowhere to go but here.
  if (s.startsWith('#')) return quote(s);
  if (EMAILISH.test(s)) return quote('mailto:' + s);
  // No scheme, so the author meant a web address. Leading slashes are dropped
  // rather than kept, which is what turns the protocol-relative `//evil.example`
  // into `https://evil.example`: a Bento document is usually opened from
  // `file://`, where `//host` means a LOCAL path and a root-relative `/x` means
  // the filesystem root — neither is ever what somebody typing a link meant.
  return quote('https://' + s.replace(/^\/+/, ''));
}

/**
 * Percent-encode the characters that could end an HTML attribute.
 *
 * Belt and braces: this is the renderer's job (NEEDS FROM THE CORE #1) and it
 * is not doing it, so nothing THIS feature writes into a document will carry a
 * quote out to `innerHTML`. It is also simply correct — a bare `"` or backtick
 * in a URL is invalid and every browser encodes it anyway.
 */
const quote = (s: string) =>
  s.replace(/"/g, '%22').replace(/'/g, '%27').replace(/`/g, '%60')
   .replace(/</g, '%3C').replace(/>/g, '%3E');

/** The second gate: an href already in the model, checked before it is FOLLOWED. */
export function safeHref(href: string | undefined): string | null {
  return href ? sanitizeUrl(href) : null;
}

// ───────────────────────────────────────────────────────────── mark math
//
// All of it goes through inline.ts. There is no offset arithmetic in this file
// and there must never be: `removeMark` already knows how to split a mark that
// straddles the range, and `addMark` already normalizes, which is what keeps
// the canonical form — and therefore the signature — stable.

/**
 * Put a link on [from,to), replace the one that is there, or clear it.
 *
 * REMOVE-THEN-ADD, never `toggleMark`. Re-targeting a link means the range is
 * already fully covered by a link mark, and `toggleMark` reads full coverage as
 * "the user wants this off" — so editing a link's URL would delete it instead.
 */
export function setLink(marks: Mark[], len: number, from: number, to: number,
                        href: string | null): Mark[] {
  const cleared = removeMark(marks, len, from, to, 'link');
  return href === null ? cleared : addMark(cleared, len, { t: 'link', from, to, href });
}

/**
 * The link the caret is standing on, if any.
 *
 * Inclusive at BOTH ends, unlike `activeAt` — deliberately. `activeAt` answers
 * "what would I be typing in", where the leading boundary is outside; this
 * answers "which link am I looking at", where standing on the first character
 * of a link obviously means that one.
 */
export function linkAt(marks: Mark[] | undefined, at: number): Mark | undefined {
  return (marks ?? []).find(m => m.t === 'link' && at >= m.from && at <= m.to);
}

/** Does any link overlap [from,to)? The autolink guard. */
export function hasLinkIn(marks: Mark[] | undefined, from: number, to: number): boolean {
  return (marks ?? []).some(m => m.t === 'link' && m.from < to && m.to > from);
}

// ───────────────────────────────────────────────────────────── autolink

export interface Autolink { from: number; to: number; href: string }

/** The three shapes worth guessing at. Anchored, so a token matches whole. */
const AUTO = [
  /^https?:\/\/[^\s/?#]+\S*$/i,                        // an explicit web URL
  /^www\.[^\s/?#]+\.[a-zA-Z]{2,24}(?:[/?#]\S*)?$/i,    // the www. idiom
  EMAILISH,
];

/** Closing punctuation a sentence puts after a URL rather than inside it. */
const TRAIL = '.,;:!?\'"”’»)]}';
const PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Longest token we will look back over — a bound, so a pathological line cannot stall typing. */
const MAX_TOKEN = 2048;

/**
 * The word just completed by a space, if it is a URL that is not already linked.
 *
 * Returns model offsets, so the caller applies it through `setLink` like any
 * other link and the undo step is an ordinary one.
 */
export function autolinkAt(text: string, caret: number, marks: Mark[] = []): Autolink | null {
  // The O(1) gate. Every keystroke that is not a space stops here.
  if (caret < 2 || caret > text.length) return null;
  const sp = text[caret - 1];
  if (sp !== ' ' && sp !== '\u00a0') return null;

  let end = caret - 1;
  let from = end;
  const floor = Math.max(0, end - MAX_TOKEN);
  while (from > floor && !/\s/.test(text[from - 1])) from--;
  if (from === end) return null;

  // Strip sentence punctuation, but keep a closing bracket that something in
  // the URL opened — `…/Foo_(bar)` is the classic case, and a URL that loses
  // its last character is worse than one that keeps a stray dot.
  while (end > from && TRAIL.includes(text[end - 1])) {
    const ch = text[end - 1];
    const open = PAIR[ch];
    if (open) {
      const slice = text.slice(from, end);
      if (count(slice, open) >= count(slice, ch)) break;
    }
    end--;
  }
  if (end <= from) return null;

  const token = text.slice(from, end);
  if (!AUTO.some(re => re.test(token))) return null;
  // Never inside an existing link: re-linking a link is at best a no-op and at
  // worst replaces a URL the author chose with the text they happened to type.
  if (hasLinkIn(marks, from, end)) return null;

  const href = sanitizeUrl(token);
  return href ? { from, to: end, href } : null;
}

// ═══════════════════════════════════════════════════════════════ the UI
//
// Everything below needs a browser. Guarded so the module still imports under
// `node`, which is what lets the rig test the logic above without a DOM — the
// same rule inline.ts states for itself, and for the same reason: a module that
// only runs in one of the two environments passes every test in the other.

let CTX: FeatureContext | null = null;
/** See NEEDS FROM THE CORE #3 — the ctx arrives with the first entry point. */
const remember = (ctx: FeatureContext) => { CTX = ctx; return ctx; };

interface Target { id: string; from: number; to: number }

/** Commit a link change and put the caret back where the author left it. */
function applyLink(ctx: FeatureContext, tgt: Target, href: string | null,
                   caret: { id: string; at: number; to?: number }): void {
  const blk = ctx.store.block(tgt.id);
  if (!blk) return;
  ctx.store.breakRun();          // its own undo step, not folded into typing
  ctx.store.commit(d => {
    const b = d.body.find(x => x.id === tgt.id);
    if (!b) return;
    const marks = setLink(b.marks ?? [], b.text.length, tgt.from, tgt.to, href);
    if (marks.length) b.marks = marks; else delete b.marks;
  }, { scope: { block: tgt.id } });
  ctx.refresh();
  ctx.editor.setCaret(caret);
}

// ───────────────────────────────────────────────────────────── popover

let pop: HTMLElement | null = null;
let popAnchor: HTMLElement | null = null;

function closePopover(): void {
  pop?.remove();
  pop = null;
  popAnchor?.classList.remove('t-link-on');
  popAnchor = null;
}

/**
 * Where to put the popover: the selection's rectangle, or — when the caret is
 * merely sitting inside a link — the link's own box, which is also what tells
 * the author WHICH link they are about to edit when several sit in a line.
 */
/**
 * The rendered <a> for a target range — by OFFSET, not by href.
 *
 * "The first anchor in the block" and "the anchor whose href matches" are both
 * wrong the moment a paragraph carries two links, and two links to the same
 * page is not an exotic document. Counting characters is the same walk the
 * caret uses, footnote markers excluded for the same reason: they occupy a
 * position and no characters, so counting them shifts every anchor after one.
 */
function anchorFor(host: HTMLElement, tgt: Target): HTMLElement | null {
  const block = host.querySelector<HTMLElement>(`[data-id="${CSS.escape(tgt.id)}"]`);
  if (!block) return null;
  let at = 0;
  let found: HTMLElement | null = null;
  const walk = (n: Node): void => {
    if (found) return;
    if (n.nodeType === 3) { at += n.nodeValue?.length ?? 0; return; }
    if (n.nodeType !== 1) return;
    const el = n as HTMLElement;
    if (isNoteAtom(el)) return;
    const start = at;
    for (const c of Array.from(el.childNodes)) { walk(c); if (found) return; }
    if (el.tagName === 'A' && start < tgt.to && at > tgt.from) found = el;
  };
  for (const c of Array.from(block.childNodes)) { walk(c); if (found) break; }
  return found;
}

function anchorRect(host: HTMLElement, tgt: Target): DOMRect {
  const a = anchorFor(host, tgt);
  // Marked whether or not it is what we position against: with a caret sitting
  // in one of three links on a line, "which one am I editing" is the question
  // the popover exists to answer, and the address in the field only answers it
  // for someone who already knows.
  if (a) { popAnchor = a; a.classList.add('t-link-on'); }
  const sel = getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
  if (r && r.width) return r;                       // a real selection: point at it
  if (a) return a.getBoundingClientRect();          // a bare caret: point at the link
  return r ?? host.getBoundingClientRect();
}

function openPopover(ctx: FeatureContext, tgt: Target, current: string | null): void {
  closePopover();
  const rect = anchorRect(ctx.editor.host, tgt);

  const box = document.createElement('div');
  box.className = 't-link-pop';

  const field = document.createElement('input');
  field.type = 'text';
  field.className = 't-link-url';
  field.spellcheck = false;
  field.placeholder = t('https://example.com');
  field.value = current ?? '';
  field.setAttribute('aria-label', t('Link address'));

  const btn = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `t-btn ${cls}`;
    b.textContent = label;
    // mousedown, so the button acts before the input's blur can close us
    b.addEventListener('mousedown', e => { e.preventDefault(); fn(); });
    return b;
  };

  const commit = () => {
    const href = sanitizeUrl(field.value);
    if (!href) {
      // An empty field on an existing link means "unlink" — the gesture people
      // already have. Anything else is a URL we refused, and saying so beats
      // silently doing nothing.
      if (!field.value.trim() && current) { closePopover(); applyLink(ctx, tgt, null, { id: tgt.id, at: tgt.from, to: tgt.to }); return; }
      ctx.toast(t('That is not an address this document can link to'));
      return;
    }
    closePopover();
    applyLink(ctx, tgt, href, { id: tgt.id, at: tgt.from, to: tgt.to });
  };

  box.append(field, btn(t('Apply'), 't-link-ok', commit));
  if (current) {
    box.append(
      btn(t('Open'), 't-link-open', () => { closePopover(); openHref(current); }),
      btn(t('Remove'), 't-link-rm', () => {
        closePopover();
        applyLink(ctx, tgt, null, { id: tgt.id, at: tgt.from, to: tgt.to });
      }),
    );
  }

  field.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
      ctx.editor.setCaret({ id: tgt.id, at: tgt.from, to: tgt.to });
    }
    e.stopPropagation();      // ⌘K and friends belong to the document, not here
  });

  document.body.appendChild(box);
  pop = box;
  // Positioned after mounting, because the width is not known before it.
  const w = box.offsetWidth, h = box.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
  const below = rect.bottom + 8;
  box.style.left = `${left}px`;
  box.style.top = `${below + h < innerHeight ? below : Math.max(8, rect.top - h - 8)}px`;
  field.focus();
  field.select();
}

function openHref(href: string): void {
  // Re-sanitised at the moment of following, never trusted from the model:
  // this href may have arrived in a file somebody else wrote.
  const safe = safeHref(href);
  if (safe) open(safe, '_blank', 'noopener,noreferrer');
}

// ─────────────────────────────────────────────────────── the entry point

function openLinkEditor(ctx: FeatureContext): void {
  remember(ctx);
  if (pop) { closePopover(); return; }              // ⌘K again closes it
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret in the document first')); return; }
  const blk = ctx.store.block(c.id);
  if (!blk) return;

  const selected = c.to !== undefined && c.to !== c.at;
  if (selected) {
    const from = Math.min(c.at, c.to!), to = Math.max(c.at, c.to!);
    // If the whole selection sits in one link, this is an EDIT of that link,
    // so the field opens with its address rather than empty.
    const inner = linkAt(blk.marks, from + 1);
    const whole = inner && inner.from <= from && inner.to >= to ? inner : undefined;
    openPopover(ctx, { id: c.id, from, to }, whole?.href ?? null);
    return;
  }

  const here = linkAt(blk.marks, c.at);
  if (!here) { ctx.toast(t('Select the words you want to link')); return; }
  openPopover(ctx, { id: c.id, from: here.from, to: here.to }, here.href ?? null);
}

// ────────────────────────────────────────────────────────── registration

registerTool({
  id: 'link',
  icon: ICONS.link,
  // A GETTER, not a value. `registerTool` runs at module scope, and a t() call
  // there freezes before the viewer's locale is resolved — the rule i18n.ts
  // states. Reading it lazily makes this label behave exactly like every label
  // main.ts sets from script.
  get title() { return t('Link (⌘K)'); },
  group: 'format',
  order: 60,
  run: openLinkEditor,
  active: ctx => {
    remember(ctx);
    const c = ctx.editor.caret();
    if (!c) return false;
    const blk = ctx.store.block(c.id);
    return !!linkAt(blk?.marks, c.at);
  },
});

registerKey({ key: 'k', mod: true, run: openLinkEditor });

if (typeof document !== 'undefined') {
  /**
   * A CLICK IN THE DOCUMENT PLACES THE CARET; IT DOES NOT NAVIGATE.
   *
   * This is an editing surface, and a link that walks the browser away from an
   * unsaved document the moment you try to put the caret in it is a data-loss
   * bug, not a hyperlink. ⌘/Ctrl-click opens, which is the modifier that means
   * "actually follow this" everywhere else, and the popover has an Open button
   * for people who do not know that.
   *
   * Capture phase, on the document: contentEditable's own handling and any
   * later listener both come after, and this needs no FeatureContext.
   */
  document.addEventListener('click', e => {
    const el = e.target as Element | null;
    const a = el?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || !a.closest('.t-paper')) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) openHref(a.getAttribute('href') ?? '');
  }, true);

  // Autolink. Bubble phase and on the document, so the editor's own `input`
  // listener has already written the typed character into the model.
  document.addEventListener('input', () => {
    const ctx = CTX;
    if (!ctx || pop) return;
    const c = ctx.editor.caret();
    if (!c || (c.to !== undefined && c.to !== c.at)) return;
    const blk = ctx.store.block(c.id);
    if (!blk) return;
    const hit = autolinkAt(blk.text, c.at, blk.marks ?? []);
    if (!hit) return;
    applyLink(ctx, { id: c.id, from: hit.from, to: hit.to }, hit.href, { id: c.id, at: c.at });
  });

  // Clicking away, or scrolling the page under it, dismisses the popover —
  // a floating box that outlives the thing it points at reads as a glitch.
  document.addEventListener('mousedown', e => {
    if (pop && !pop.contains(e.target as Node)) closePopover();
  }, true);
  window.addEventListener('resize', closePopover);
}
