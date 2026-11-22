#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

LOG_DIR="${TAUF_DATA_DIR:-$HOME/.tauf}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/runtime.log"

# Prefer native Tauri binary if compiled & executable
if [ -x "$APP_DIR/src-tauri/target/release/tauf" ]; then
  exec "$APP_DIR/src-tauri/target/release/tauf" "$@"
fi
if [ -x "$APP_DIR/src-tauri/target/debug/tauf" ]; then
  exec "$APP_DIR/src-tauri/target/debug/tauf" "$@"
fi
if [ -d "$APP_DIR/src-tauri/target/release/bundle/macos/TAUF.app" ] && command -v open >/dev/null 2>&1; then
  exec open "$APP_DIR/src-tauri/target/release/bundle/macos/TAUF.app"
fi

# Locate portable Node.js (>=18)
NODE_BIN="${TAUF_NODE_EXE:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    for candidate in \
      /usr/local/bin/node \
      /opt/homebrew/bin/node \
      "$HOME/.volta/bin/node" \
      "$HOME/.nvm/current/bin/node"; do
      if [ -x "$candidate" ]; then
        NODE_BIN="$candidate"
        break
      fi
    done
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [TAUF] Could not locate node (>=18). Install Node.js >=18 and run 'npm run setup'." >>"$LOG_FILE"
  echo "TAUF error: Node.js (>=18) not found in PATH." >&2
  exit 1
fi

nohup "$NODE_BIN" "$APP_DIR/local-server.mjs" --open "$@" >>"$LOG_FILE" 2>&1 </dev/null &
