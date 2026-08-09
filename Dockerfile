# syntax=docker/dockerfile:1.7

# ---- deps (full: dev + prod, used for the build step) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# ---- prod-only deps (for the runtime image) ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ----
# TODO: pin by digest (node:22-alpine@sha256:...) once a stable tag is chosen
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    npm_config_update_notifier=false

# tini as PID 1 so SIGTERM propagates correctly during rolling restarts
RUN apk add --no-cache tini wget && \
    addgroup -g 10001 -S app && \
    adduser -u 10001 -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY package.json ./

USER 10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
