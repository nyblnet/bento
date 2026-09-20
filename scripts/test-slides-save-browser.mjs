// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import { runSaveQueueBrowser } from './lib/savequeue-browser.mjs'
await runSaveQueueBrowser({ app: 'slides', title: '.ed-title', dirty: '.ed-dirty.on' })
