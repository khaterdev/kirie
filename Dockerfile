FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

ARG KIRIE_DOCKER_APT_PACKAGES=""
RUN if [ -n "$KIRIE_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $KIRIE_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Copy workspace config and all package.json files for install layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/daemon/package.json ./apps/daemon/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/memory/package.json ./packages/memory/package.json
COPY packages/media/package.json ./packages/media/package.json
COPY packages/voice/package.json ./packages/voice/package.json
COPY packages/canvas/package.json ./packages/canvas/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/skills/package.json ./packages/skills/package.json
COPY channels/telegram/package.json ./channels/telegram/package.json
COPY channels/discord/package.json ./channels/discord/package.json
COPY channels/slack/package.json ./channels/slack/package.json
COPY channels/whatsapp/package.json ./channels/whatsapp/package.json
COPY channels/signal/package.json ./channels/signal/package.json

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime
RUN chown -R node:node /app

# Security hardening: run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
USER node

CMD ["node", "apps/daemon/dist/index.js"]
