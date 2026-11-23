#!/usr/bin/env bash
# Build the image Kirie's docker sandbox mode uses (PLAN C.10). Run once, with
# Docker Desktop running, from anywhere inside the repository:
#
#   scripts/sandbox-setup.sh
#
# Kirie never pulls this image from a registry. Rebuild after changing
# Dockerfile.sandbox, then run /sandbox recreate in Telegram.
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-}"
if [[ -z "${DOCKER}" ]]; then
  for candidate in /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [[ -x "${candidate}" ]]; then DOCKER="${candidate}"; break; fi
  done
fi
if [[ -z "${DOCKER}" ]]; then
  echo "No docker binary found. Install Docker Desktop, or set DOCKER=/path/to/docker." >&2
  exit 1
fi
if ! "${DOCKER}" info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

IMAGE_NAME="kirie-sandbox:bookworm-slim"
"${DOCKER}" build --pull=false -t "${IMAGE_NAME}" -t "kirie-sandbox:latest" -f Dockerfile.sandbox .
echo "Built ${IMAGE_NAME} (also tagged kirie-sandbox:latest)."
echo "Next: /sandbox docker in Telegram (or /sandbox recreate if docker mode is already on)."
