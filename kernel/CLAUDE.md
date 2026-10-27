# kernel — shared machinery every app depends on

Kernel changes are serialized (one at a time; see `docs/PARALLEL-WORK.md`), and
`docs/PLATFORM.md` invariants bind everything here.

The design notes for most of this directory were written while it lived in
slides, and are still in `slides/CLAUDE.md`. Read the matching section before
changing:

- save/splice, the compressed shell, previews: "`src/save.ts`", "`src/preview.ts`",
  "Compressed shell (Phase 1)"
- autosave and recovery: "`src/autosave.ts`"
- signed update: "`src/update.ts`"
- animation: "`src/anim.ts`", "Animation robustness"
- charts: "`src/charts.ts`"
- i18n: "`src/i18n.ts`"
- sync, the relay and access control: "`src/sync/`", "Signed writes / read-only
  tiers", "File modes"
