# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
