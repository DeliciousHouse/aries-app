# syntax=docker/dockerfile:1.7

ARG ARIES_NODE_UID=1004
ARG ARIES_NODE_GID=1004

FROM node:24-bookworm AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

FROM node:24-bookworm AS runner
ARG ARIES_NODE_UID=1004
ARG ARIES_NODE_GID=1004
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8100
ENV CODE_ROOT=/app
ENV DATA_ROOT=/data
ENV HOME=/home/node

RUN set -eux; \
  apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    chromium \
    curl \
    ripgrep \
    wget \
  && rm -rf /var/lib/apt/lists/*; \
  current_uid="$(id -u node)"; \
  current_gid="$(id -g node)"; \
  if [ "$current_gid" != "$ARIES_NODE_GID" ]; then \
    groupmod -o -g "$ARIES_NODE_GID" node; \
  fi; \
  if [ "$current_uid" != "$ARIES_NODE_UID" ]; then \
    usermod -o -u "$ARIES_NODE_UID" -g "$ARIES_NODE_GID" node; \
  fi; \
  mkdir -p /home/node /data/generated/draft /data/generated/validated; \
  chown -R node:node /home/node /data /app

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && chown -R node:node /home/node /app

COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/app ./app
COPY --from=builder --chown=node:node /app/auth.ts ./auth.ts
COPY --from=builder --chown=node:node /app/backend ./backend
COPY --from=builder --chown=node:node /app/components ./components
COPY --from=builder --chown=node:node /app/frontend ./frontend
COPY --from=builder --chown=node:node /app/hooks ./hooks
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/styles ./styles
COPY --from=builder --chown=node:node /app/specs ./specs
COPY --from=builder --chown=node:node /app/templates ./templates
COPY --from=builder --chown=node:node /app/types ./types
COPY --from=builder --chown=node:node /app/validators ./validators
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/lobster ./lobster
COPY --from=builder --chown=node:node /app/next-env.d.ts ./next-env.d.ts
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=node:node /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder --chown=node:node /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/README-runtime.md ./README-runtime.md

USER node

EXPOSE 8100
CMD ["npm", "run", "start"]
