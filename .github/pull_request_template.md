<!-- Thanks for contributing! Keep PRs focused — one concern each. -->

**What & why**
What does this change, and what problem does it solve?

**How I verified it**
<!-- e.g. ran `npm run build:single`; for CRDT changes ran `node scripts/test-sync.ts`;
     real-mouse QA for canvas/Moveable changes -->

**Checklist**
- [ ] Read the relevant parts of CLAUDE.md / docs before changing them
- [ ] `npm run build:single` succeeds (from `slides/`)
- [ ] Ran `node scripts/test-sync.ts` if I touched `slides/src/sync/`
- [ ] New UI strings added to every catalog in `slides/src/i18n/`
- [ ] Document format changes are additive and backward-compatible
- [ ] Did not bump the version or cut a release (maintainers sign releases)
