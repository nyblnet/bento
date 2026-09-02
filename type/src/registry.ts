// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE ONE PLACE a feature module is switched on.
//
// Importing a feature file runs its registration; main.ts then renders whatever
// the registry holds. This file exists so that adding a feature is a one-line
// diff in a file nobody else is editing, instead of a diff in main.ts — which
// is what lets several features be built at once without three-way conflicts
// in the chrome.
//
// Order here is registration order, which decides ties within a toolbar group.
// Anything order-sensitive should say so with an explicit `order` instead of
// relying on this list.

import './props.ts';   // the properties panel — Text, Picture, Table, Caption
import './image.ts';   // pictures — insert, embed, atomic pagination
import './embed.ts';   // embedded Bento artifacts — a Dash chart, a Slides deck
import './blockgrip.ts';  // the margin handle that reorders a block, and ⌥⇧↑/↓
import './seltoolbar.ts';  // the formatting bar that appears over a selection
import './find.ts';    // find and replace — panel, ⌘F, replace all
// captions, automatic figure/table numbering and cross-references
import './xref.ts';
import './layout.ts';   // paragraph properties, page setup, page breaks
import './cite.ts';       // citations, the bibliography and the BibTeX import
import './math.ts';      // mathematics: inline formulas and display equations

export {};
import './link.ts';
import './toc.ts';        // section numbering + table of contents
// comments — margin notes on a range of text, with replies and resolution.
// Anchors ride inline.ts `shift`, so they move exactly as marks and footnote
// anchors do; nothing here can reach print (see the header of comments.ts).
import './comments.ts';
// tracked-changes review: next/previous, accept/reject at the caret, and the
// All markup/No markup/Original display modes. track.ts is the engine; this
// is what makes an eighty-change document usable.
import './review.ts';
import './redlineview.ts';  // snapshot redlining — own panel host, see its header
// auto-save + crash recovery: a debounced IndexedDB snapshot, a restore
// banner on boot when it disagrees with the loaded file, and version
// history (About dialog). See autosave.ts's header for the full design.
import './autosave.ts';
// the static first-page render written into every saved file, for readers
// (thumbnailers) that run no script — see preview.ts's header.
import './preview.ts';
