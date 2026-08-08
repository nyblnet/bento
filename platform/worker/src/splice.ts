// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Request-time half of the split shell trick (see platform/build/split-shell.mjs
// for the build-time half). Serving a deck is `SHELL_HEAD + escape(json) +
// SHELL_TAIL` — string concatenation against two constants baked into the
// bundle, no HTML parsing, no per-request regex scan of a ~700KB shell.
//
// The escape rule is copied verbatim from kernel/src/save.ts's serializeBody
// (`body.replace(/</g, '<')`) and re-verified against the real generated
// shell by platform/worker/test/splice.test.mjs — this file must stay in sync
// with that rule, not reinvent it.
import { SHELL_HEAD, SHELL_TAIL, SHELL_VERSION, SHELL_HASH } from './generated/shell.ts'

export { SHELL_VERSION, SHELL_HASH }

/** Same `<` → `<` escape every Bento plaintext data block uses — the
 *  JSON can then never contain a literal `</script>` and break the file. */
export function escapeBlockText(json: string): string {
  return json.replace(/</g, '\\u003c')
}

/** Splice `doc` into the shell, producing a complete .bento.html document. */
export function spliceDoc(doc: unknown): string {
  return SHELL_HEAD + escapeBlockText(JSON.stringify(doc)) + SHELL_TAIL
}
