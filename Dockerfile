# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CODE_ROOT=/app
ENV DATA_ROOT=/data

# install only production deps for next start runtime
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/app ./app
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/frontend ./frontend
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/public ./public
COPY --from=builder /app/specs ./specs
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/validators ./validators
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lobster ./lobster
COPY --from=builder /app/next-env.d.ts ./next-env.d.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/README-runtime.md ./README-runtime.md

RUN mkdir -p /data/generated/draft /data/generated/validated

EXPOSE 3000
CMD ["npm", "run", "start"]
