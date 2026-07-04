# Contributing

Thanks for considering a contribution. This project values small, surgical changes over sweeping refactors.

## Development setup

There is deliberately **no build step**. `main.js` is plain JavaScript loaded directly by Obsidian.

1. Clone the repo.
2. Symlink or copy `main.js`, `manifest.json`, and `styles.css` into `<test-vault>/.obsidian/plugins/claude-mobile/`.
3. Enable the plugin; after each change, reload Obsidian (Cmd+R on desktop) or toggle the plugin off/on.

For the relay (`relay/server.mjs`): `cd relay && npm install`, create a `config.json` (see `install.sh` for the shape), and run `node server.mjs`. Node 18+ and an authenticated Claude Code install are required for end-to-end testing.

## Before you open a PR

- `node test/run.js` must pass (also enforced by CI on every PR), along with `node --check main.js` and `node --check relay/server.mjs`.
- Test the path you touched by hand: API backend, relay backend, or both. State in the PR which you tested on which platform (desktop / iOS / Android).
- Anything touching approvals, secrets, or the relay auth path is security-relevant: explain your reasoning in the PR description, not just the diff.
- Match the existing style (plain JS, no dependencies in the plugin, no framework). PRs that introduce a bundler or TypeScript need a very good argument.
- One logical change per PR.

## Hard constraints

- **No subscription-token extraction.** PRs that make the plugin call the Anthropic API with Claude subscription OAuth tokens directly (bypassing the Agent SDK) will be rejected — this violates Anthropic's Consumer Terms of Service and risks users' accounts.
- **Secrets never enter the vault.** API keys and tokens live in Obsidian's per-device local storage. Nothing secret may be written to `data.json` or any synced file.
- **Mobile compatibility is the point.** No Node APIs, no `child_process`, no Electron-only calls in `main.js`. If it doesn't run on iOS Obsidian, it doesn't ship.

## Versioning and releases

Semantic versioning:

- **patch** — bug fixes, doc changes
- **minor** — new features, new settings (backwards compatible)
- **major** — breaking changes to settings, the relay protocol, or the approval model

Release checklist (maintainers):

1. Bump `version` in `manifest.json`.
2. Add the new version to `versions.json` mapping it to the minimum Obsidian `minAppVersion`.
3. Add a dated entry to `CHANGELOG.md` (Keep a Changelog format).
4. Commit, tag `X.Y.Z` (bare version, **no `v` prefix** — required by the Obsidian community-plugin pipeline), push with `--tags`.
5. The `Release` workflow creates the GitHub release automatically on tag push, attaching `main.js`, `manifest.json`, and `styles.css` with artifact attestations. Do not create releases by hand — hand-made releases lack attestations.

The relay and plugin are versioned together; a relay protocol change (the NDJSON event shapes or endpoints) is at least a minor bump and must be called out in the changelog.
