#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type first-page preview rig.
//
//   node scripts/test-type-preview.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Every save writes a static rendering of page one into the
// shell so file managers can thumbnail the document (kernel/src/save.ts for the
// placement, type/src/preview.ts for the drawing — see that file's header for
// the full rationale). Everything about this feature fails SILENTLY — nobody
// proofreads markup they cannot see — and none of it is recoverable once a
// file is on disk:
//
//   1. THE ENCRYPTION VETO. An encrypted document must never carry a
//      plaintext rendering of page one. Getting this wrong publishes the
//      opening paragraphs of a contract in plaintext beside the ciphertext
//      that exists to hide them, and the owner has no way to notice.
//   2. THE OUTPUT REFUSAL. The preview is built from author content — marks,
//      links, images, embeds. A `<script>`, an `on*` handler, or a live
//      `data-*` attribute reaching the file is either a code-execution
//      surface in a document that promised to be inert without its own
//      runtime, or a hook the runtime never installs (dead weight at best,
//      a tell at worst).
//   3. THE PLACEMENT CONTRACT, owned by the kernel (kernel/src/save.ts
//      writePreview): the preview host is followed IMMEDIATELY by its
//      parser-blocking remover, with nothing paintable between them, and a
//      second save REPLACES the first preview rather than stacking another
//      one beside it. type registers nothing special here — it hands the
//      kernel an element — so this section proves the WIRING reaches the
//      kernel's real serialize path, not a second implementation of it.
//
// Laying the page out (real pagination, real line boxes) needs actual layout,
// which jsdom does not do — `getBoundingClientRect` returns all-zero rects, so
// pagination degenerates to "the whole document is page one" whenever no
// layout engine is present. That is an honest limitation, not a false pass:
// every invariant below still holds over whatever content the degenerate case
// produces, and where jsdom itself is absent, the DOM-dependent section is
// skipped with a note, exactly as scripts/test-type-font.ts already does for
// its own DOM round trip. Real pagination is verified in a browser (see the
// PR's own manual check) and by the paginator's own rig,
// scripts/test-type-layout.ts.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

import { isEncryptionActive, setEncryptionPassword } from '../kernel/src/save.ts';
import { emptyDoc, type TypeDoc, type Block } from '../type/src/model.ts';

let checks = 0, bad = 0;
const ok = (cond: boolean, msg: string) => {
  checks++;
  if (cond) console.log(`  ok    ${msg}`);
  else { bad++; console.log(`  FAIL  ${msg}`); }
};

const block = (over: Partial<Block>): Block =>
  ({ id: over.id ?? `b${Math.random().toString(36).slice(2, 8)}`, kind: 'para', text: '', ...over });

const doc = (over: Partial<TypeDoc> = {}): TypeDoc => ({ ...emptyDoc(), ...over });

// Never write these literals (AGENTS.md #1): fixtures need them as data.
const SCRIPT_OPEN = '<scr' + 'ipt';
const SCRIPT_CLOSE = '</scr' + 'ipt';

console.log('\n— the encryption veto, which buildTypePreview checks itself —');
{
  const { buildTypePreview } = await import('../type/src/preview.ts');
  ok(!isEncryptionActive(), 'starts unencrypted, so the fixture below is meaningful');
  setEncryptionPassword('hunter2');
  ok(isEncryptionActive(), 'the flag is now on');
  const withBody = doc({ body: [block({ kind: 'h1', text: 'Confidential Merger Terms' })] });
  ok(buildTypePreview(withBody) === null, 'an encrypted document gets NO preview, even with real content');
  setEncryptionPassword(null);
  ok(!isEncryptionActive(), 'cleared for the rest of this file');
}

console.log('\n— an empty document gets no preview either —');
{
  const { buildTypePreview } = await import('../type/src/preview.ts');
  const blank = doc({ body: [] });
  ok(buildTypePreview(blank) === null, 'no body at all -> null, same as a pristine shell with nothing typed yet');
  // Both branches above return before touching `document` — asserted by the
  // fact this ran at all: this rig has no DOM shim in scope yet.
  ok(typeof (globalThis as { document?: unknown }).document === 'undefined',
     'both checks above ran with no DOM present, proving they never reach into one');
}

console.log(`\n${checks - bad}/${checks} checks passed`);

// ─────────────────────────────────────────────── the DOM-dependent section

const { JSDOM } = await (async () => {
  try { return await import('jsdom'); } catch { return { JSDOM: null as never }; }
})();

if (!JSDOM) {
  console.log('\n— skipped: jsdom is not installed —');
  console.log('  --    the static-markup, ordering and replace-vs-append checks below need a DOM;');
  console.log('  --    verified instead in a real browser (see the PR notes) and by');
  console.log('  --    scripts/test-type-layout.ts for the paginator itself.');
} else {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>t</title></head><body><div id="bento-splash"></div></body></html>',
  );
  const g = globalThis as {
    document?: unknown; window?: unknown; HTMLElement?: unknown; Node?: unknown;
    NodeFilter?: unknown; performance?: unknown;
  };
  g.document = dom.window.document;
  g.window = dom.window;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  if (!g.performance) g.performance = { now: () => Date.now() } as unknown;

  const { buildTypePreview, PREVIEW_BUDGET } = await import('../type/src/preview.ts');
  const save = await import('../kernel/src/save.ts');
  const { configureApp } = await import('../kernel/src/app.ts');
  configureApp({ appId: 'bento-type-test', appName: 'Bento Type (test)', manifestUrl: 'about:blank' });

  ok(PREVIEW_BUDGET > 0 && PREVIEW_BUDGET <= 256 * 1024, 'the budget is a real, bounded number, not a vibe');

  const richDoc = (): TypeDoc => doc({
    title: 'Distribution Agreement',
    body: [
      block({ kind: 'h1', text: 'Distribution Agreement' }),
      block({
        kind: 'para',
        text: 'This agreement is made between the parties, click here for details.',
        marks: [{ t: 'b', from: 0, to: 4 } as never],
      }),
      block({
        kind: 'para',
        text: 'A malicious clause',
        marks: [{ t: 'a', from: 0, to: 4, href: 'javascript:alert(1)' } as never],
      }),
      block({
        kind: 'image',
        text: '',
        image: { src: 'data:image/png;base64,AAAA', alt: 'A seal' } as never,
      }),
      block({
        kind: 'image',
        text: '',
        image: { src: 'https://evil.example/track.png', alt: 'remote' } as never,
      }),
    ],
  });

  console.log('\n— the markup itself: nothing that could run, load, or leak —');
  {
    const el = buildTypePreview(richDoc());
    ok(!!el, 'a document with real content gets a preview');
    const html = el!.outerHTML;
    ok(!html.toLowerCase().includes(SCRIPT_OPEN.toLowerCase()), 'no <script> anywhere in the preview markup');
    ok(!/\son[a-z]+\s*=/i.test(html), 'no on* handler attributes');
    ok(!/\sdata-[a-z-]+\s*=/i.test(html), 'no runtime data-* attributes survive staticizing');
    ok(!/\scontenteditable\s*=/i.test(html), 'no contenteditable attribute');
    ok(!/\shref\s*=/i.test(html), 'no href — a preview must not be a live link, javascript: or otherwise');
    ok(!html.includes('evil.example'), 'a remote image URL never reaches the file');
    ok(html.includes('data:image/png;base64,AAAA'), 'an already-embedded data: image is kept — it costs no request');
    ok(html.includes('Distribution Agreement'), 'the actual document content is what got rendered');
  }

  console.log('\n— replace, never append: two saves leave exactly one preview —');
  {
    // Wire the real kernel path, the way registry.ts really does, so this
    // proves the WIRING and the kernel's placement contract together rather
    // than re-implementing writePreview's own rig.
    save.registerPreview(d => buildTypePreview(d as unknown as TypeDoc));
    save.capturePristine();
    const d = richDoc();
    const first = save.serializeFile(d as never);
    // Three hits, not two: the host's own attribute, the remover script's
    // attribute, AND the attribute name spelled out inside the remover's own
    // JS text (it selects `[data-bento-preview]` to delete both). That is the
    // kernel's own literal (kernel/src/save.ts PREVIEW_REMOVER) — this pins
    // the COUNT so a stacked second preview (6 hits) is caught below, not the
    // exact constant, which is the kernel's to change.
    const hostCount1 = (first.match(/data-bento-preview/g) ?? []).length;
    ok(hostCount1 === 3, `exactly one host + one remover after the first save (got ${hostCount1} occurrences)`);

    // A second save must REPLACE, not stack another preview on top —
    // capturePristine is NOT called again here, mirroring how a real second
    // save reuses the boot-time snapshot rather than re-snapshotting itself.
    const second = save.serializeFile({ ...d, title: 'Distribution Agreement (revised)' } as never);
    const hostCount2 = (second.match(/data-bento-preview/g) ?? []).length;
    ok(hostCount2 === 3, `still exactly one host + one remover after a SECOND save (got ${hostCount2}), not two stacked previews`);
  }

  console.log('\n— ordering: the remover follows the host with nothing paintable between —');
  {
    save.registerPreview(d => buildTypePreview(d as unknown as TypeDoc));
    save.capturePristine();
    const html = save.serializeFile(richDoc() as never);
    const hostOpen = html.indexOf('data-bento-preview');
    ok(hostOpen >= 0, 'a preview was written');
    // Between the host's own closing and the remover's opening there must be
    // nothing but that element's own close tag and the remover's open tag —
    // i.e. the remover script is the host's very next sibling.
    const afterHost = html.slice(hostOpen);
    const removerRel = afterHost.indexOf(SCRIPT_OPEN);
    ok(removerRel > 0, 'a remover script follows the host somewhere after it');
    // The host is a (possibly deeply nested) <div>; its OWN closing tag —
    // not some inner element's — must be the thing immediately preceding the
    // remover's opening `<script`. Anything else between them is markup a
    // scriptless renderer could paint before the remover ever runs.
    const immediatelyBefore = afterHost.slice(Math.max(0, removerRel - '</div>'.length), removerRel);
    ok(immediatelyBefore.toLowerCase() === '</div>',
       `the host's own </div> is the remover's immediate predecessor (got "${immediatelyBefore}")`);
    ok(afterHost.indexOf(SCRIPT_CLOSE) > removerRel, 'and the remover script is actually closed');
  }

  console.log('\n— an encrypted save carries no preview at all, end to end —');
  {
    save.registerPreview(d => buildTypePreview(d as unknown as TypeDoc));
    save.capturePristine();
    setEncryptionPassword('hunter2');
    try {
      const html = await save.serializeDocInto(dom.window.document, richDoc() as never);
      ok(!html.includes('data-bento-preview'), 'no preview markers anywhere in an encrypted save');
    } finally {
      setEncryptionPassword(null);
    }
  }
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
