// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The convert library's whole public surface, in one entry: PowerPoint in
// (api.ts) and PowerPoint out (export.ts). The CLI bundles this. Hosts that
// need only one direction import that file directly, as bento.page/import
// does with api.ts.

export * from './api.ts'
export * from './export.ts'
export { foldReport, slideRange, type FoldedEntry } from './report.ts'
