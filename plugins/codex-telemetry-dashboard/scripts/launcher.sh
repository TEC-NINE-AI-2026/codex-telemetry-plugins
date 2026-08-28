#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_path=""

if [ -n "${CODEX_BUNDLED_NODE:-}" ] && [ -x "$CODEX_BUNDLED_NODE" ]; then
  node_path=$CODEX_BUNDLED_NODE
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  node_path="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
elif [ -x "$HOME/Library/Caches/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  node_path="$HOME/Library/Caches/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  node_path=$(command -v node)
else
  echo 'Node.js was not found. Install Node.js 22.5 or newer, then retry.' >&2
  exit 1
fi

exec "$node_path" "$script_dir/launcher.mjs" "$@"
