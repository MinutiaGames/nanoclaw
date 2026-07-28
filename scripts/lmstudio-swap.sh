#!/bin/bash
#
# Resets LM Studio (kill, wait for VRAM to actually be released, relaunch,
# cycle the API server) and optionally loads a model afterward — one call
# to reliably swap models during the local-model bake-off, instead of the
# manual restart-and-reload dance. See handoff_lms.md and
# scripts/lmstudio-reset.ps1 for the full background.
#
# LM Studio itself only runs on the Windows side of this dev machine; this
# shells out to PowerShell via WSL interop to do the actual work, so it
# only works run from WSL on the same machine LM Studio is installed on.
#
# Usage:
#   ./scripts/lmstudio-swap.sh                       # reset only
#   ./scripts/lmstudio-swap.sh google/gemma-4-12b-qat # reset, then load

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PS1_WIN_PATH="$(wslpath -w "$SCRIPT_DIR/lmstudio-reset.ps1")"

if [ $# -gt 0 ]; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1_WIN_PATH" -Model "$1"
else
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1_WIN_PATH"
fi
