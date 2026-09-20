# bento/slides review improvements

This branch depends on `codex/kernel-document-state`. It changes slides only;
spaces/dash save adoption and the font lifecycle follow-up to #516 are separate.
No release version or document format is changed.

## Test in the browser

Build with `npm run build:single --prefix slides`, then open
`slides/dist-single/Bento_Slides.bento.html`.

- Use two tabs of the same saved deck. Undo a local edit: newer collaborator
  fields remain. Save → Recent changes lets you explicitly revert a selected
  change, including a remote change. This log lasts for the session only.
- Press Command/Ctrl+K to search actions, slide text and notes.
- Speaker notes → Edit text and notes: edit two slides before Apply; both drafts
  persist and one Undo reverses the batch. Modified text becomes plain text.
- About → File size shows document/asset estimates beside picture compression;
  it excludes the embedded editor, encryption and final HTML compression.
- Save, Shape, Media, Language and Slideshow menus support arrows/Home/End/Escape.
- On a narrow viewport, More actions holds Recent changes; Format opens notes.
- Large-deck thumbnails render on demand; unchanged canvas content keeps its DOM.
- Save during editing: completion of an older write keeps newer edits unsaved.

## Verification

CI runs `test-slides-history.ts`, `test-slides-savequeue.ts`,
`test-slides-review-browser.mjs` and `test-slides-save-browser.mjs`.
The browser job installs pinned Playwright/Chromium and builds the standalone
file. Local browser runs accept PLAYWRIGHT_MODULE and CHROME_PATH overrides.
Browser saves use delayed mock writable streams, with real app serialization;
these tests do not cover native OS permission dialogs or native phone keyboards.

## Ownership

Kernel owns JSON copying, conditional differences/reversal and save ordering.
Slides owns ignored history metadata, grouping, memory budget, view repair,
at-least-one-slide rules, thumbnails and action UI. History is field-level,
not character-level; a newer rich-text value is preserved as a whole.
