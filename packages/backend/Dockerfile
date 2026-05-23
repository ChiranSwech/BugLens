# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace files
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Install all dependencies (needed for workspace resolution)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

# Build shared first, then backend
RUN pnpm --filter @bugbuddy/shared build
RUN pnpm --filter @bugbuddy/backend build

# ─── Stage 2: Production API ──────────────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY packages/backend/db ./packages/backend/db

# Create non-root user (never run as root in production)
RUN addgroup -g 1001 bugbuddy && adduser -u 1001 -G bugbuddy -s /bin/sh -D bugbuddy
RUN mkdir -p /app/keys && chown bugbuddy:bugbuddy /app/keys

USER bugbuddy

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "packages/backend/dist/server.js"]

# ─── Stage 3: Worker ─────────────────────────────────────────────────────────
FROM production AS worker

CMD ["node", "packages/backend/dist/workers/runner.js"]
