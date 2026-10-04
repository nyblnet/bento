// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The line-tip catalogue moved to the kernel (kernel/src/tips.ts) with the
// diagram-engine lift so bento/spaces diagram connectors share it. Re-exported
// here so every existing `./tips` / `../tips` import — and the rendered tips —
// are unchanged.
export * from '../../kernel/src/tips.ts'
