# Store listing — Bento Tray

Copy for the Chrome Web Store developer dashboard, and the same text serves Edge
Add-ons. Kept in the repo so the answers a reviewer gets are the answers the code
actually supports, and so the next submission does not reinvent them.

Build the upload with `node scripts/pack-webext.mjs` → `dist/bento-tray-<v>.zip`.

---

## Name

```
Bento Tray
```

## Summary (132 characters max)

```
Save a Bento document back to the file you opened, with no destination prompt.
```

## Category

Productivity → Workflow & Planning

## Description

```
Bento documents are single HTML files — the document, the viewer and the editor
in one. Open one by double-clicking it and the browser will let it read itself,
but not write itself: the first time you press Cmd-S, you get a "save as" dialog
asking where to put a file that already has a home.

Bento Tray fixes that. Point it at the folder your documents live in, once. From
then on, Cmd-S writes straight back to the file you opened. No dialog, no second
copy appearing beside the original, no wondering which one is current.

WHAT IT DOES NOT DO

"Save a copy", read-only copies, presentation packages and templates all still
ask you where to put the new file — because those are new files, and choosing
where they go is the point. The extension only ever writes the document you
already had open.

It sends nothing anywhere. There is no account, no sync and no server. It reads
and writes files inside the one folder you choose, and nothing else on your
computer.

REQUIREMENTS

After installing, turn on "Allow access to file URLs" on this extension's card
in chrome://extensions. Chrome requires you to enable that by hand — no
extension can do it for you — and nothing works until it is on. The toolbar icon
tells you whether it is, along with whether your folder is still granted.

Bento is open source: https://github.com/nyblnet/bento
```

## Single purpose

```
Bento Tray lets a locally-opened Bento document save back to its own file
instead of prompting for a destination. That is its only function.
```

## Permission justifications

**`storage`**

```
Stores the handle for the one folder the user grants, so the folder does not
have to be chosen again on every browser restart. No document content is stored.
```

**File access (`file:///*.bento.html` content scripts)**

```
Bento documents are opened from disk, so the extension has to run on file:// to
do anything at all. The match pattern is limited to *.bento.html rather than all
local HTML, so it never touches unrelated local files. Two scripts are needed
because Chrome separates the worlds: one runs in the page to provide the save
entry point, and one relays to the extension, which is the only part that
touches the filesystem.
```

**Why no host permissions**

```
The extension makes no network requests and needs no access to any website.
```

## Data usage disclosures

| Question | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| **Website content** | **No** — file contents are read and written locally and never transmitted |

Certifications: does not sell or transfer data to third parties; does not use or
transfer data for purposes unrelated to the single purpose; does not use or
transfer data to determine creditworthiness or for lending.

**Privacy policy URL** — required once any data question is answered yes. All
are no here, so a policy should not be required; if the dashboard insists,
`https://bento.page/privacy` is the address to publish one at.

---

## Screenshots — NOT YET MADE

1280×800 or 640×400, at least one, up to five. What to capture:

1. A deck open from disk with the toolbar popup showing green on both rows —
   the state a working install is in.
2. The options page with a folder granted.
3. The moment that motivates the extension: the "save as" dialog you get
   *without* it, beside a document that already has a filename.

A small promo tile (440×280) is optional but improves placement.

---

## Before submitting

- [ ] `node scripts/pack-webext.mjs` produces the zip with no problems reported
- [ ] Load that exact zip unpacked and run the three save paths — in-place
      silent, "Save a copy…" prompts, an export prompts
- [ ] Test on a **clean browser profile**, which is the only way to see what a
      new user sees: no grant, file access off, nothing primed
- [ ] Confirm the popup reports file access correctly rather than falling to
      "unknown" (`chrome.extension.isAllowedFileSchemeAccess()` behaviour under
      MV3 is still unverified — the code handles the null case, but a real
      reading is better than a handled unknown)
- [ ] Screenshots
- [ ] Developer account (one-off fee)
