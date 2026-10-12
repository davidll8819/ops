#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node scripts/setup-local.mjs
if ! docker info >/dev/null 2>&1; then colima start --cpu 2 --memory 4; fi
docker compose -p wishtaday-local up -d --wait
node --env-file=.env scripts/bootstrap-local.mjs
npm run build
node scripts/local-process.mjs stop
node scripts/local-process.mjs start
open http://localhost:3000
