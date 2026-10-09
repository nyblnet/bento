// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// COMPARE WITH A FILE — the surface over comparedoc.ts.
//
// comparedoc.ts reads the other document and decides the direction; this file
// asks for the file, says what happened in the reader's language, and hands the
// change set to redlineview.ts to paint. The split is redline.ts/redlineview.ts
// again, and for the same reason: the part that can be silently wrong is
// testable in node, and the part that needs a browser holds no correctness.
//
// TWO RULES THIS FILE EXISTS TO KEEP.
//
// 1. IT IS A VIEW. Comparing must not touch the document and must not reach the
//    saved file — the rule the theme and the locale already follow. Concretely:
//    the panel offers no Accept/Reject here, because "reject" against a base
//    that is somebody ELSE'S document means adopting their text wholesale,
//    which is a merge and not a comparison. `showComparison` is passed
//    `resolvable:false` for exactly that, and nothing in this file calls
//    `store.commit`.
//
// 2. THE DIRECTION IS SAID OUT LOUD, in the heading, naming both ends — never
//    shortened to "7 changes". A redline nobody can orient is worse than none,
//    and the cards cannot carry the orientation themselves.
//
// The degenerate cases are as much the feature as the diff is: a file from
// another Bento app, a file that is not Bento at all, corrupt JSON, an
// identical file (answered, never painted as an empty list), and a document
// with a different docId — that last one being LEGITIMATE, since comparing two
// unrelated documents is a real thing to want, but usually the wrong file. So
// it is noted, not refused.

import './compare.css';
import { t } from './i18n.ts';
import { registerMenuItem, type FeatureContext } from './features.ts';
import { compareDocs, readTypeDoc, type CompareRead } from './comparedoc.ts';
import { pickFile } from './embed.ts';
import { showComparison } from './redlineview.ts';

const el = (tag: string, cls?: string): HTMLElement => {
  const n = document.createElement(tag); if (cls) n.className = cls; return n;
};

/** Everything a saved `.bento.html` or a bare document may arrive as. */
const ACCEPT = '.html,text/html,.json,application/json';

/**
 * The reason a comparison could not be made, in the reader's language.
 *
 * Built here rather than in comparedoc.ts so the reading half stays free of
 * i18n and runs in node — and every `t()` sits inside a function, never in a
 * module-level const where it would freeze before the viewer's locale resolves.
 */
function whyNot(r: Extract<CompareRead, { ok: false }>): string {
  switch (r.kind) {
    case 'other-app':
      return t('That is a {app} file, not a bento/type document.').replace('{app}', r.found ?? '');
    case 'not-bento':
      return t('That file does not look like a bento/type document.');
    case 'empty':
      return t('That file has no document in it.');
    default:
      return t('That file could not be read: {detail}').replace('{detail}', r.detail);
  }
}

/**
 * The caveats worth raising once a comparison HAS been made.
 *
 * A thunk, and it stays one all the way into the panel: the panel repaints on
 * every store event and the About dialog can change locale under it, so a
 * string resolved at compare time would be the wrong language from then on.
 */
function caveats(cmp: { sameDocId: boolean }, repaired: string[]): () => string {
  const parts: Array<() => string> = [];
  if (!cmp.sameDocId) {
    parts.push(() => t('That file is a different document, not another copy of this one — comparing unrelated documents works, but check you picked the file you meant.'));
  }
  if (repaired.length) {
    parts.push(() => (repaired.length === 1
      ? t('One problem in that file was repaired as it was read, which can itself appear below as a change.')
      : t('{n} problems in that file were repaired as it was read, which can themselves appear below as changes.')
          .replace('{n}', String(repaired.length))));
  }
  parts.push(() => t('This is a view: changes are shown, never applied. Accept and reject are offered only against a Snapshot of this document.'));
  return () => parts.map(p => p()).join(' ');
}

/** Read one picked or dropped file, and either explain the problem or show the redline. */
export async function compareWithFile(ctx: FeatureContext, file: File): Promise<void> {
  let text: string;
  try { text = await file.text(); }
  catch (e) { ctx.toast(t('That file could not be read: {detail}').replace('{detail}', (e as Error).message)); return; }

  const read = readTypeDoc(text);
  if (!read.ok) { ctx.toast(whyNot(read)); return; }

  const live = ctx.store.doc;
  const cmp = compareDocs(read.doc, live, live.meta?.author || 'you');

  // An empty redline is indistinguishable from a comparison that never
  // happened, so this case is ANSWERED and the panel is never opened on it.
  if (cmp.identical) {
    ctx.toast(t('That file is identical to this document — there is nothing to compare.'));
    return;
  }

  const n = cmp.set.changes.length;
  showComparison(ctx, {
    base: { docId: read.doc.docId, body: read.doc.body },
    set: cmp.set,
    heading: () => (n === 1
      ? t('1 change from “{file}” to this document')
      : t('{n} changes from “{file}” to this document').replace('{n}', String(n))
    ).replace('{file}', file.name),
    note: caveats(cmp, read.repaired),
    resolvable: false,
  });
}

/**
 * ⋯ → Compare with a file…
 *
 * A dialog rather than a bare file picker, for two reasons that are both about
 * the direction: it is the only place with room to say which way the redline
 * will read BEFORE the reader is looking at one, and a drop target only exists
 * if there is something to drop onto. bento/type has no other drop handling, so
 * the zone is scoped to this box rather than to the page — a document-wide
 * handler would be sitting in the way of the one pictures will want later.
 */
export function openCompare(ctx: FeatureContext): void {
  const back = el('div', 't-overlay');
  const box = el('div', 't-dlg t-compare');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const h = el('h3');
  h.textContent = t('Compare with another document');
  box.appendChild(h);

  const blurb = el('p', 't-about-blurb');
  blurb.textContent = t('Choose another bento/type file. The redline shows what changed from that file to this document. Comparing never changes what you have open.');
  box.appendChild(blurb);

  const zone = el('div', 't-compare-drop');
  const zoneText = el('div');
  zoneText.textContent = t('Drop a Bento document here');
  const choose = el('button', 't-btn') as HTMLButtonElement;
  choose.type = 'button';
  choose.textContent = t('Choose a file…');
  zone.append(zoneText, choose);
  box.appendChild(zone);

  const foot = el('div', 't-dlg-foot');
  const cancel = el('button', 't-btn') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.textContent = t('Cancel');
  foot.appendChild(cancel);
  box.appendChild(foot);

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  }
  const take = (f: File | null | undefined): void => {
    if (!f) return;
    close();
    void compareWithFile(ctx, f);
  };

  cancel.addEventListener('click', close);
  choose.addEventListener('click', () => { void pickFile(ACCEPT).then(take); });
  // `dragover` MUST be prevented, on the scrim as well as the zone: without it
  // the browser navigates to the dropped file, which throws away the document
  // the reader has open. That is the one failure mode here that loses work.
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    take(e.dataTransfer?.files?.[0]);
  });
  back.addEventListener('dragover', e => e.preventDefault());
  back.addEventListener('drop', e => e.preventDefault());
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  window.addEventListener('keydown', onKey, true);

  back.appendChild(box);
  document.body.appendChild(back);
  choose.focus();
}

registerMenuItem({
  id: 'compare',
  // a thunk, not t('…') — see features.ts's `Label`
  label: () => t('Compare with a file…'),
  // beside the snapshot review whose panel it borrows
  order: 35,
  run: openCompare,
});
