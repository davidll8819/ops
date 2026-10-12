#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node scripts/local-process.mjs stop
docker compose -p wishtaday-local stop
