# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.1] - 2026-07-04

### Added
- Release workflow with GitHub artifact attestations: release assets (`main.js`, `manifest.json`, `styles.css`) are now built, attested, and published by GitHub Actions on tag push, addressing the community-directory review recommendation. Verify with `gh attestation verify`.
- README disclosure for vault enumeration by `search_vault` (all file paths are visible to the plugin; matches are sent to the configured backend).

## [1.4.0] - 2026-07-04

### Changed
- Renamed from "Claude Mobile" to **Vault Companion for Claude** (plugin id `vault-companion-for-claude`) to comply with trademark naming guidance. Device-local secret storage keeps its original key prefix, so stored API keys and relay tokens survive the rename.
- Release tags now use the bare version number (`1.4.0`, no `v` prefix), per Obsidian community-plugin convention.

### Added
- CI workflow (GitHub Actions): syntax checks, JSON and version-map validation, unit tests.
- Unit test suite (`test/`) covering SSE stream parsing, vault tools, the approval contract, and per-device secret handling.
- README disclosures section (network use, account/payment requirements, file access) per Obsidian developer policies.

## [1.3.0] - 2026-07-04

### Added
- Auto-approve ("YOLO") mode: optional setting that skips all approval cards on both backends. Auto-approved actions are listed as ⚡ lines in the chat; the header shows a YOLO indicator while active.

## [1.2.0] - 2026-07-04

### Changed
- **Security:** API key and relay token moved from synced `data.json` to Obsidian's per-device local storage. Legacy secrets found in `data.json` are migrated and scrubbed automatically. Secrets must now be entered once per device.
- **Security:** relay `/health` no longer discloses the vault path.

### Fixed
- Relay now supports up to 5 concurrent chats (multiple devices at once) instead of rejecting with 409. Approval requests are scoped per chat, so ending one chat no longer cancels another chat's pending approvals.

## [1.1.0] - 2026-07-04

### Added
- Mac relay backend: chat via the Claude Agent SDK on a Mac running Claude Code, billed to a Claude subscription. NDJSON streaming, session resume, and device-side approval of writes and Bash commands.
- Relay server (`relay/`): token-protected HTTP service with `launchd` installer.

## [1.0.0] - 2026-07-04

### Added
- Initial release. Mobile-compatible Obsidian plugin (`isDesktopOnly: false`) chatting with the Anthropic Messages API: streaming with non-streaming fallback, agentic tool loop over the Obsidian Vault API (`read_note`, `get_active_note`, `list_folder`, `search_vault`, `create_note`, `update_note`), approval cards for all writes, optional `CLAUDE.md` system context, settings tab.
