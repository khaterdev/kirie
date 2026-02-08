#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="kirie-sandbox:bookworm-slim"

docker build -t "${IMAGE_NAME}" -t "kirie-sandbox:latest" -f Dockerfile.sandbox .
echo "Built ${IMAGE_NAME} (also tagged kirie-sandbox:latest)"
