// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The packaged slides editor, real ⌘S and auto-save, file writes held open:
// an edit made during a write stays dirty, writes never overlap, and the dot
// goes out only once the deck on screen is the one on disk. Same helper as
// spaces and dash (scripts/lib/savequeue-browser.mjs).
import { runSaveQueueBrowser } from './lib/savequeue-browser.mjs'
await runSaveQueueBrowser({ app: 'slides', title: '.ed-title', dirty: '.ed-dirty.on' })
