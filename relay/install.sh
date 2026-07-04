#!/bin/bash
# Claude Relay installer — copies the relay out of iCloud to ~/claude-relay,
# installs the Agent SDK, generates a token, and registers a launchd service.
set -euo pipefail

# Usage: ./install.sh [/path/to/your/vault]
# Without an argument, assumes the script lives at <vault>/scripts/claude-relay/.
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/claude-relay"
VAULT="${1:-$(cd "$SRC/../.." && pwd)}"
if [ ! -d "$VAULT" ]; then echo "Vault path not found: $VAULT" >&2; exit 1; fi
PLIST="$HOME/Library/LaunchAgents/com.sander.claude-relay.plist"
NODE_BIN="$(command -v node)"

mkdir -p "$DEST"
cp "$SRC/server.mjs" "$SRC/package.json" "$DEST/"

if [ ! -f "$DEST/config.json" ]; then
  TOKEN=$(openssl rand -hex 24)
  cat > "$DEST/config.json" <<EOF
{
  "token": "$TOKEN",
  "vaultPath": "$VAULT",
  "port": 8814,
  "defaultModel": ""
}
EOF
  echo "Generated new token."
fi

cd "$DEST" && npm install --silent

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sander.claude-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/relay.log</string>
  <key>StandardErrorPath</key><string>$DEST/relay.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.sander.claude-relay" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 2
echo "--- health check ---"
curl -s http://127.0.0.1:8814/health || true
echo
echo "Token: $(node -e "console.log(require('$DEST/config.json').token)")"
echo "Done. Logs: $DEST/relay.log / relay.err.log"
