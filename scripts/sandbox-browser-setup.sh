#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="kirie-sandbox-browser:bookworm-slim"

docker build -t "${IMAGE_NAME}" -t "kirie-sandbox-browser:latest" -f Dockerfile.sandbox-browser .
echo "Built ${IMAGE_NAME} (also tagged kirie-sandbox-browser:latest)"
