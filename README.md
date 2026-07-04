# Vault Companion for Claude

[![CI](https://github.com/estrenuo/vault-companion-for-claude/actions/workflows/ci.yml/badge.svg)](https://github.com/estrenuo/vault-companion-for-claude/actions/workflows/ci.yml)

Chat with Claude inside Obsidian on **iPhone, iPad, Android, and desktop** — including agentic access to your vault (read, search, create, and update notes), with an approval card for every write.

> This is an independent community plugin. It is not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic, PBC.

Existing Claude integrations for Obsidian (such as Claudian) embed the Claude Code CLI as a child process, which makes them desktop-only: mobile Obsidian has no Node runtime and cannot spawn processes. This plugin takes a different route and therefore runs anywhere Obsidian runs.

## Two backends

### 1. Anthropic API key (standalone)

The plugin calls the Anthropic Messages API directly over HTTPS. Claude's tools (`read_note`, `get_active_note`, `list_folder`, `search_vault`, `create_note`, `update_note`) are implemented on Obsidian's own Vault API, so no server or desktop machine is needed. Billing is per token via your API key from [platform.anthropic.com](https://platform.anthropic.com).

### 2. Mac relay (Claude subscription)

A small Node server (in [`relay/`](relay/)) runs on a Mac that has [Claude Code](https://claude.com/claude-code) installed and authenticated. It wraps the **Claude Agent SDK** with your vault as the working directory and exposes a token-protected HTTP endpoint that the plugin streams from. This gives you:

- Usage billed to your existing Claude subscription (Pro/Max) instead of per-token API pricing
- The full Agent SDK toolset: file read/write/edit, grep/glob, web access
- Your vault's `CLAUDE.md` loaded automatically
- Multi-turn sessions, and up to 5 concurrent chats (several devices at once)
- Write and Bash actions held until you tap **Approve** on your device

**Why the relay instead of putting your subscription token in the plugin:** Anthropic blocks subscription OAuth tokens outside Claude Code/Agent SDK server-side (enforced April 2026) and prohibits it in the Consumer ToS. Routing through the Agent SDK on your own machine is the sanctioned path. This plugin deliberately does not implement token extraction.

The catch: your Mac must be on and reachable from your mobile device — same Wi-Fi, or any VPN into your home network (Tailscale, a home OpenVPN server, WireGuard). A commercial VPN subscription does not give your phone a route to your Mac.

## Installation

### Plugin (all devices)

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vault-companion-for-claude/` (or download them from the latest [release](../../releases)).
2. Obsidian → Settings → Community plugins → disable Restricted mode → enable **Vault Companion for Claude**.
3. Open the plugin's settings and configure a backend.

The plugin folder syncs with your vault (iCloud/Obsidian Sync), so you install once and enable per device.

### Relay (Mac, optional — for subscription backend)

Requirements: Node 18+, Claude Code installed and logged in.

```bash
./relay/install.sh /path/to/your/vault
```

This copies the relay to `~/claude-relay`, installs the Agent SDK, generates a bearer token in `config.json` (chmod 600), and registers a `launchd` service that starts at login. Then in plugin settings: Backend → *Mac relay*, Relay URL → `http://<mac-ip>:8814`, Relay token → the value from `~/claude-relay/config.json`.

Health check: `curl http://<mac-ip>:8814/health` → `{"ok":true}`.

## Security model

- **Secrets stay on-device.** The API key and relay token are stored in Obsidian's per-device local storage — never in the vault, never in synced `data.json`. Enter them once per device.
- **Every write needs approval** — unless you enable *Auto-approve ("YOLO") mode*, which skips all cards and (via the relay) also lets Claude run Bash on the Mac unattended. Auto-approved actions remain visible in the chat and the header shows a YOLO indicator.
- The relay authenticates every request (constant-time bearer token comparison); the unauthenticated `/health` endpoint reveals nothing but liveness.
- Relay traffic is plain HTTP — run it over a VPN or trusted LAN only, and never port-forward 8814 to the internet.

## Disclosures

Per Obsidian's developer policies, in plain terms:

- **Network use.** The API backend sends your prompts and any note content Claude reads to `api.anthropic.com`. The relay backend sends them to a server **you** run on your own machine, which in turn uses the Claude Agent SDK (Anthropic). Nothing is sent anywhere else; there is no telemetry.
- **Accounts and payment required.** The plugin is useless without either an Anthropic API key (paid, per token) or a Claude subscription plus a self-hosted relay. Neither is included.
- **Files are read and written.** Claude can read any file in your vault via its tools, and — after your approval, or without it in YOLO mode — create and modify notes. The relay backend additionally allows approved Bash commands on the relay machine.

## Limitations

- No conversation persistence across pane closes ("New chat" starts fresh; relay sessions resume server-side within a chat).
- API backend: `update_note` replaces whole files; content search skips files over 300 KB.
- API backend has no semantic search, no shell, no web tools — that is what the relay backend is for.

## Versioning

Semantic versioning. See [CHANGELOG.md](CHANGELOG.md) for release history and [versions.json](versions.json) for the Obsidian version compatibility map. Release process is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
