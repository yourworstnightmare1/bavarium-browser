#!/usr/bin/env bash
# Run the Bavarium build script on macOS/Linux (requires PowerShell: brew install powershell)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell (pwsh) is required. Install: brew install powershell" >&2
  exit 1
fi
exec pwsh -NoProfile -File "$ROOT/scripts/build-bavarium.ps1" "$@"
