# syntax=docker/dockerfile:1
#
# Donor Scout — production container image.
# ---------------------------------------------------------------------------
# Multi-stage so the runtime image carries only what it needs to RUN, not the
# toolchain used to BUILD. Two non-obvious things this stack requires:
#   1. better-sqlite3 is a NATIVE addon — it must be compiled (python3/make/g++)
#      against the image's platform, NOT copied from the host. That's why
#      node_modules is .dockerignore'd and installed fresh inside the build stage.
#   2. The Express server serves the built React SPA from client/dist in one
#      origin, so we build the client here and copy only its dist/ output.
# The SQLite database lives on a mounted volume at /data (DATA_DIR), so it
# survives container restarts and image rebuilds.

# ---- Build stage: compile native deps + build the SPA --------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for better-sqlite3's native build (removed from the final image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Server production dependencies. --omit=dev compiles better-sqlite3 but skips
# devDependencies (nodemon), giving us the exact node_modules the runtime needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Client build needs its own (dev) dependencies, but only dist/ is kept.
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci

# Now bring in the source and build the SPA.
COPY . .
RUN npm --prefix client run build

# ---- Runtime stage: minimal, non-root -----------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# NODE_ENV=production hardens the session cookie (Secure flag → HTTPS only). For
# local HTTP testing under Colima, docker-compose overrides this (see compose).
ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/data

# Production node_modules (with the compiled native addon) + app + built client.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/lib ./lib
COPY --from=build /app/cause.config.js ./cause.config.js
COPY --from=build /app/package.json ./package.json

# Persistent SQLite lives on a volume, owned by the non-root runtime user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 5000

# Liveness check hitting GET /healthz (no auth, no DB). Uses node's built-in http
# client so we don't have to install curl/wget into the slim runtime image. Exits
# 0 on a 200, non-zero otherwise → the orchestrator restarts an unhealthy
# container. /healthz is intentionally cheap and does NOT touch the DB.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
