# Bento docs

Engineering and format documentation for Bento Slides. Start here.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | How a `.bento.html` file is built, the on-disk anatomy, the self-save loop, the runtime layout, and signed updates. |
| [format.md](format.md) | **Normative reference for the `bento/slides` JSON document model** — every element type, slide/state/layout shape, `fx`, and the collab fields. The format IS the product. |
| [agents.md](agents.md) | The AI-agent guide: how to author a *great* deck (mapping content to the right feature), the schema, and copy-paste recipes. Also published at `bento.page/agents.md`. |
| [collab-design.md](collab-design.md) | The live-collaboration design: the in-house CRDT, the E2EE blind relay, signed-write RBAC, and the threat model. |
| [RELEASING.md](RELEASING.md) | How a signed release is cut locally, the two-repo site publish, and deploying the sync relay. |

Related, outside `docs/`:

- [../CLAUDE.md](../CLAUDE.md) — the deep, module-by-module development guide
  with the hard-won gotchas (also what AI agents read to work in this repo).
- [../CHANGELOG.md](../CHANGELOG.md) — the version history.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — setup, conventions, the splice
  contract, and how to open a PR.
- [../SECURITY.md](../SECURITY.md) — the security posture and how to report a
  vulnerability.
