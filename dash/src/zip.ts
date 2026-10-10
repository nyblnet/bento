// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: the ZIP reader/writer lives in the shared kernel now
// (kernel/src/convert/zip.ts) — it is the container .xlsx, .pptx and .docx all
// share, and the convert engine is its second consumer. Same pattern as
// slides/src/charts.ts over kernel/src/charts.ts; call sites are unchanged.
export * from '../../kernel/src/convert/zip.ts'
