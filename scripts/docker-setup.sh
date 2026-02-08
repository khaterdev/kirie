#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
IMAGE_NAME="${KIRIE_IMAGE:-kirie:local}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

KIRIE_CONFIG_DIR="${KIRIE_CONFIG_DIR:-$HOME/.kirie}"
mkdir -p "$KIRIE_CONFIG_DIR"

export KIRIE_CONFIG_DIR
export KIRIE_GATEWAY_PORT="${KIRIE_GATEWAY_PORT:-18789}"
export KIRIE_IMAGE="$IMAGE_NAME"
export KIRIE_DOCKER_APT_PACKAGES="${KIRIE_DOCKER_APT_PACKAGES:-}"

# Ensure sandbox-browser image is available if browser is enabled
export KIRIE_BUILD_BROWSER="${KIRIE_BUILD_BROWSER:-0}"

# Generate master key if not set
if [[ -z "${KIRIE_MASTER_KEY:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    KIRIE_MASTER_KEY="$(openssl rand -base64 32)"
  else
    KIRIE_MASTER_KEY="$(python3 -c 'import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())')"
  fi
fi
export KIRIE_MASTER_KEY

ENV_FILE="$ROOT_DIR/.env"
cat >"$ENV_FILE" <<EOF
KIRIE_CONFIG_DIR=${KIRIE_CONFIG_DIR}
KIRIE_GATEWAY_PORT=${KIRIE_GATEWAY_PORT}
KIRIE_IMAGE=${KIRIE_IMAGE}
KIRIE_MASTER_KEY=${KIRIE_MASTER_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOF

echo "==> Building Docker image: $IMAGE_NAME"
docker build \
  --build-arg "KIRIE_DOCKER_APT_PACKAGES=${KIRIE_DOCKER_APT_PACKAGES}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/Dockerfile" \
  "$ROOT_DIR"

echo ""
echo "==> Running interactive setup"
docker compose -f "$COMPOSE_FILE" run --rm kirie-cli setup

echo ""
echo "==> Starting daemon"
docker compose -f "$COMPOSE_FILE" up -d kirie-daemon

echo ""
echo "Kirie is running."
echo "Config: $KIRIE_CONFIG_DIR"
echo "Master key saved to: $ENV_FILE"
echo ""
echo "Commands:"
echo "  docker compose -f $COMPOSE_FILE logs -f kirie-daemon"
echo "  docker compose -f $COMPOSE_FILE run --rm kirie-cli chat"
