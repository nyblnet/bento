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

import './find.ts';    // find and replace — panel, ⌘F, replace all

export {};
