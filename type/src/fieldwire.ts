// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The two pieces of fields.ts's feature that need toc.ts or model.ts at RUN
// time, wired from here so fields.ts itself imports neither.
//
// fields.ts is imported BY model.ts, so whatever it imports joins model.ts's
// own import graph: importing toc.ts there closes model → fields → toc →
// render → model, and toc runs against a half-evaluated render.ts (see the
// note above fields.ts `measure`). This module is loaded from registry.ts,
// beside toc.ts, long after model.ts has finished evaluating, so it can import
// all three statically.
//
// These used to be dynamic `import()`s inside fields.ts. In a single-file build
// they compile to Vite's lazy-import helper, which carries `import.meta.url`,
// and a bundle containing that cannot run as a classic script.

import { t } from './i18n.ts';
import { registerMenuItem, registerPaginated } from './features.ts';
import { bindTokens, measure } from './fields.ts';
import { spliceText } from './model.ts';
import { pageOfY } from './toc.ts';
import type { Metrics } from './paginate.ts';

registerPaginated((ctx, metrics, paper) => {
  const m = metrics as Metrics;
  if (!m?.pages?.length) return;
  // a microtask, as when this waited on the lazy import: measuring runs after
  // the pagination pass's other hooks, not in the middle of them
  queueMicrotask(() => measure(ctx, m, paper, pageOfY));
});

registerMenuItem({
  id: 'fields-from-tokens',
  label: () => t('Turn {{…}} tokens into fields'),
  order: 61,
  run: ctx => {
    let n = 0;
    ctx.store.breakRun();
    ctx.store.commit(d => { n = bindTokens(d, spliceText); });
    ctx.editor.render();
    ctx.refresh();
    ctx.toast(n
      ? t('{n} field(s) created from tokens').replace('{n}', String(n))
      : t('No {{…}} tokens found in this document'));
  },
});
