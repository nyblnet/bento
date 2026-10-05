// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The exact cubic-bezier path model now lives in the kernel (kernel/src/geom.ts)
// so bento/spaces diagrams share one engine with slides. This file re-exports it
// unchanged, so every existing `./bezier` import — and the behaviour — is intact.
export {
  type Pt,
  type BezNode,
  parseBezier,
  serializeBezier,
  cubicAt,
  nearestT,
  splitSegment,
  mirrorHandle,
  handleLen,
} from '../../../kernel/src/geom.ts'
